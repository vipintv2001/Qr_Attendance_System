const express = require("express");
const path = require("path");
const cors = require("cors");
const fetch = require("node-fetch");
const fs = require("fs");
const mongoose = require("mongoose");
const QRCode = require("qrcode"); // For terminal and file QR generation
const Attendance = require("./models/Attendance"); // Ensure this path matches your schema file

const app = express();
app.use(cors());
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ limit: "10mb", extended: true }));

app.use(express.static(path.join(__dirname, "public")));

// 🗄️ Connect to Local MongoDB Instance (Standard Port 27017)
mongoose
  .connect("mongodb://127.0.0.1:27017/teche_attendance")
  .then(() => {
    console.log("💾 MongoDB Connected Successfully");
    // Run the cleanup engine immediately after a successful database handshake
    clearForgottenCheckouts();
  })
  .catch((err) => console.error("Database connection failure:", err));

// 🧹 MORNING STARTUP SWEEP: Auto-resolves forgotten checkouts from yesterday or earlier
async function clearForgottenCheckouts() {
  try {
    const now = new Date();
    const todayStr = now.toLocaleDateString("en-CA"); // Current date matching project criteria string format

    console.log(
      `🧹 Checking for unclosed attendance shifts prior to: ${todayStr}...`,
    );

    const result = await Attendance.updateMany(
      {
        dateString: { $lt: todayStr }, // Any record older than today's string format
        $or: [{ checkOut: { $exists: false } }, { checkOut: null }],
      },
      {
        $set: {
          checkOut: null, // Leaves database object clean or standardizes it
          workSummary: "Not Added", // Custom flag matching your prompt logic
          status: "Pending", // Day status flagged as pending
        },
      },
    );

    if (result.modifiedCount > 0) {
      console.log(
        `✅ Startup Cleanup Complete: Swept and auto-checked out ${result.modifiedCount} old employee session(s).`,
      );
    } else {
      console.log(
        "✅ Startup Cleanup Complete: No forgotten shifts detected from prior days.",
      );
    }
  } catch (error) {
    console.error("❌ Error running startup auto-checkout cleanup:", error);
  }
}

const REGISTRY_FILE = path.join(__dirname, "device_registry.json");
const EMPLOYEE_FILE = path.join(__dirname, "employees.json");

// Helpers for file persistence fallback
const getDeviceRegistry = () =>
  fs.existsSync(REGISTRY_FILE)
    ? JSON.parse(fs.readFileSync(REGISTRY_FILE))
    : {};
const saveDeviceRegistry = (data) =>
  fs.writeFileSync(REGISTRY_FILE, JSON.stringify(data, null, 2));

// Helper to look up employee names locally
const getEmployeeName = (empId) => {
  if (!fs.existsSync(EMPLOYEE_FILE)) return "Team Member";
  const directory = JSON.parse(fs.readFileSync(EMPLOYEE_FILE));
  return directory[empId.toLowerCase()] || "Team Member";
};

app.post("/api/attendance", async (req, res) => {
  // 📥 Destructure workSummary directly from incoming form submit payload
  const { employeeId, attendanceAction, deviceToken, workSummary } = req.body;

  if (!employeeId || !deviceToken) {
    return res.status(400).send("Missing parameters.");
  }

  const registry = getDeviceRegistry();
  const now = new Date();

  // 📅 FIX: Forces strict local YYYY-MM-DD formatting to prevent UTC timezone rollover bugs at midnight
  const todayStr = now.toLocaleDateString("en-CA");

  // 👥 Dynamic Name Fetching
  const employeeName = getEmployeeName(employeeId);

  // 🔒 DEVICE VERIFICATION LOGIC
  if (!registry[employeeId]) {
    registry[employeeId] = deviceToken;
    saveDeviceRegistry(registry);
    console.log(`📱 Registered new device for user: ${employeeId}`);
  } else {
    if (registry[employeeId] !== deviceToken) {
      console.log(
        `⚠️ BLOCKED: Proxy attempt! ${employeeId} tried checking from an unlinked device.`,
      );
      return res.status(403).send(`
            <div style="font-family:sans-serif; text-align:center; padding-top:100px; color:#ef4444;">
                <h2>🚫 Access Denied</h2>
                <p>Device mismatch. You must submit attendance from your own registered mobile device.</p>
            </div>
      `);
    }
  }

  // ==========================================
  // 💾 STEP 1: WRITE & CALCULATE IN MONGO DB
  // ==========================================
  let responseHtml = "";

  try {
    // Look if a MongoDB log already exists for this employee today
    let record = await Attendance.findOne({ employeeId, dateString: todayStr });

    if (attendanceAction === "Check-In") {
      if (!record) {
        record = new Attendance({
          employeeId,
          employeeName,
          dateString: todayStr,
          checkIn: now,
        });
      } else {
        record.checkIn = now; // Overwrite if scanning check-in again on the same day
      }
      await record.save();

      const checkInTimeStr = now.toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      });
      const estimatedEst = new Date(now.getTime() + 8 * 60 * 60 * 1000);
      const estimatedStr = estimatedEst.toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
      });

      responseHtml = `
              <div class="card">
                  <div class="icon" style="color:#10b981;">✓</div>
                  <h2>Shift Started</h2>
                  <p>Welcome to work, <b>${employeeName}</b>! Your start log has been secured.</p>
                  <div class="data-table">
                      <div class="data-row"><span class="label">Name</span><span class="value" style="color:#4f46e5;">${employeeName}</span></div>
                      <div class="data-row"><span class="label">Employee ID</span><span class="value">${employeeId.toUpperCase()}</span></div>
                      <div class="data-row"><span class="label">Clocked In</span><span class="value">${checkInTimeStr}</span></div>
                      <div class="data-row"><span class="label">Est. Checkout (+8h)</span><span class="value" style="font-weight:700;">${estimatedStr}</span></div>
                  </div>
              </div>`;
    } else {
      // Check-Out Logic
      let durationStr = "--";
      let statusStr = "Completed";
      let statusColor = "#64748b";

      if (!record) {
        // ⚠️ NEW DAY ROLLOVERS RULE: If checking out on a fresh calendar cell day without checking in,
        // initialize a safe modern record layout containing their work notes summary straight away
        record = new Attendance({
          employeeId,
          employeeName,
          dateString: todayStr,
          checkOut: now,
          workSummary: workSummary || "Logged checkout directly.",
        });
      } else {
        record.checkOut = now;
        record.workSummary = workSummary || ""; // Save user text input safely into DB row instance

        if (record.checkIn) {
          const diffMs = record.checkOut - record.checkIn;
          record.totalMinutes = Math.floor(diffMs / 1000 / 60);

          const hours = Math.floor(record.totalMinutes / 60);
          const minutes = record.totalMinutes % 60;
          durationStr = `${hours}h ${minutes}m`;

          const standardWorkMins = 8 * 60;
          const varianceMins = record.totalMinutes - standardWorkMins;
          const varHours = Math.floor(Math.abs(varianceMins) / 60);
          const varMins = Math.abs(varianceMins) % 60;

          if (varianceMins >= 0) {
            statusStr = `+${varHours}h ${varMins}m Overtime`;
            statusColor = "#10b981";
          } else {
            statusStr = `-${varHours}h ${varMins}m Short/Early`;
            statusColor = "#ef4444";
          }
        }
      }

      // Explicitly label the active runtime entry as Completed on direct standard check-outs
      record.status = "Completed";
      await record.save();

      const checkOutTimeStr = now.toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      });

      responseHtml = `
              <div class="card">
                  <div class="icon" style="color:#ea580c;">✓</div>
                  <h2>Shift Completed</h2>
                  <p>Good job today, <b>${employeeName}</b>! Your departure has been logged.</p>
                  <div class="data-table">
                      <div class="data-row"><span class="label">Name</span><span class="value" style="color:#ea580c;">${employeeName}</span></div>
                      <div class="data-row"><span class="label">Employee ID</span><span class="value">${employeeId.toUpperCase()}</span></div>
                      <div class="data-row"><span class="label">Checked Out</span><span class="value">${checkOutTimeStr}</span></div>
                      <div class="data-row"><span class="label">Total Duration</span><span class="value" style="font-weight:700;">${durationStr}</span></div>
                      <div class="data-row"><span class="label">Shift Status</span><span class="value" style="color:${statusColor}; font-weight:700;">${statusStr}</span></div>
                  </div>
                  <!-- Professional Summary Preview Component Block -->
                  <div style="margin-top:16px; background:#f8fafc; border:1px solid #e2e8f0; border-radius:12px; padding:12px; text-align:left;">
                      <span style="font-size:11px; text-transform:uppercase; font-weight:700; color:#ea580c; display:block; margin-bottom:4px; letter-spacing:0.5px;">Logged Activity Summary</span>
                      <p style="font-size:13px; color:#1e293b; margin:0; line-height:1.4; font-style:italic;">"${workSummary || "No summary text filled out."}"</p>
                  </div>
              </div>`;
    }
  } catch (mongoErr) {
    console.error("❌ Local MongoDB Save Error:", mongoErr);
  }

  // ==========================================
  // ☁️ STEP 2: WRITE TO CLOUD GOOGLE FORM/SHEET
  // ==========================================
  const GOOGLE_FORM_URL =
    "https://docs.google.com/forms/d/e/1FAIpQLSei8kh5jZmvl-iW6akR-TZyiZWzph4NV0oLV5SvrKZs1YDDdA/formResponse";
  const googleFormData = new URLSearchParams();
  googleFormData.append("entry.1609800714", employeeId);
  googleFormData.append("entry.814032963", attendanceAction);

  try {
    await fetch(GOOGLE_FORM_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: googleFormData.toString(),
    });
    console.log(`☁️ Cloud Backup Synced for ${employeeId}`);
  } catch (error) {
    console.error(
      "❌ Cloud Sync Failed (Internet offline or network blocked):",
      error,
    );
  }

  // ==========================================
  // 🖥️ STEP 3: RENDER THE RECEIPT BACK TO MOBILE
  // ==========================================
  res.send(`
        <!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Verification Receipt</title>
            <style>
                body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #f8fafc; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; }
                .card { width: 85%; max-width: 360px; background: white; padding: 40px 24px; border-radius: 24px; box-shadow: 0 10px 25px -5px rgba(0,0,0,0.03), 0 8px 10px -6px rgba(0,0,0,0.03); text-align: center; }
                .icon { font-size: 42px; margin-bottom: 20px; line-height: 1; }
                h2 { font-size: 22px; font-weight: 700; margin: 0 0 8px 0; color: #1e293b; letter-spacing: -0.5px; }
                p { color: #64748b; font-size: 14px; margin: 0 0 28px 0; line-height: 1.5; }
                .data-table { background: #f8fafc; border-radius: 14px; padding: 14px 18px; text-align: left; }
                .data-row { display: flex; justify-content: space-between; padding: 10px 0; font-size: 14px; }
                .data-row:not(:last-child) { border-bottom: 1px solid #e2e8f0; }
                .label { color: #64748b; font-weight: 500; }
                .value { color: #1e293b; font-weight: 600; }
            </style>
        </head>
        <body>
            ${responseHtml}

            <script>
                localStorage.setItem('teche_saved_name', "${employeeName}");
            </script>
        </body>
        </html>
    `);
});

// 📊 Dashboard API Fetch Engine (Aggregates Month Logs)
app.get("/api/admin/monthly-report", async (req, res) => {
  const monthFilter = req.query.month || new Date().toISOString().slice(0, 7);
  try {
    const records = await Attendance.find({
      dateString: { $regex: `^${monthFilter}` },
    }).sort({ dateString: 1 });
    res.json(records);
  } catch (err) {
    res.status(500).json([]);
  }
});

const PORT = 8080;
const LOCAL_IP = "10.194.212.29"; // Verified local laptop network IP

app.listen(PORT, () => {
  const url = `http://${LOCAL_IP}:${PORT}`;
  console.log(`\n🚀 TechE Hybrid Portal Server Online: ${url}`);

  // Generates QR directly inside your project terminal window
  QRCode.toString(url, { type: "terminal", small: true }, (err, qr) => {
    if (!err) console.log(qr);
  });

  // Saves a clean high-res image backup for printing out
  QRCode.toFile(
    path.join(__dirname, "public", "attendance_qr.png"),
    url,
    {
      width: 300,
      color: { dark: "#37144B", light: "#5EOA35" },
    },
    (err) => {
      if (!err)
        console.log(
          "💾 Clean printable QR code image refreshed at: public/attendance_qr.png\n",
        );
    },
  );
});
