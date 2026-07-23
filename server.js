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
        $or: [
          { checkOut: { $exists: false } },
          { checkOut: null },
          { checkOut: "" },
        ],
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

// 🔍 DATE-ISOLATED SCREEN STATUS ENDPOINT
app.get("/api/attendance/status/:employeeId", async (req, res) => {
  try {
    const employeeId = req.params.employeeId.toLowerCase();
    const todayStr = new Date().toLocaleDateString("en-CA");

    const record = await Attendance.findOne({
      employeeId,
      dateString: todayStr,
    });

    if (!record) {
      // Case A: No record found for today -> Return { showScreen: "checkin" }
      return res.json({ showScreen: "checkin" });
    }

    // Case B: Record found with valid checkIn AND missing/null/empty checkOut (or checkIn is after checkOut) -> Return { showScreen: "checkout" }
    const hasCheckIn = !!record.checkIn;
    const hasCheckOut =
      record.checkOut !== undefined &&
      record.checkOut !== null &&
      record.checkOut !== "" &&
      (!record.checkIn || new Date(record.checkOut) >= new Date(record.checkIn));

    if (hasCheckIn && !hasCheckOut) {
      return res.json({ showScreen: "checkout" });
    }

    // Case C: Record found where checkOut exists or is marked "Not Added" -> Return { showScreen: "checkin" }
    return res.json({ showScreen: "checkin" });
  } catch (error) {
    console.error("❌ Error fetching attendance status:", error);
    res.status(500).json({ showScreen: "checkin", error: error.message });
  }
});

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
  let alertScriptHtml = "";

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
          status: "Pending",
        });
      } else {
        record.checkIn = now; // Overwrite if scanning check-in again on the same day
        record.checkOut = null; // Clear any previous checkOut timestamp to open active shift
        record.workSummary = "";
        record.totalMinutes = 0;
        record.status = "Pending";
      }
      await record.save();

      const checkInTimeStr = now.toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      });
      // ⏱️ Estimated Checkout = Check-In Time + 7 hours 30 minutes (450 minutes)
      const estimatedEst = new Date(now.getTime() + 7.5 * 60 * 60 * 1000);
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
                      <div class="data-row"><span class="label">Est. Checkout (+7h 30m)</span><span class="value" style="font-weight:700;">${estimatedStr}</span></div>
                  </div>
              </div>`;
    } else {
      // Check-Out Logic
      let durationStr = "--";
      let statusStr = "Completed";
      let statusColor = "#64748b";
      let extraDetailsHtml = "";
      let warningBannerHtml = "";

      if (!record) {
        // ⚠️ NEW DAY ROLLOVERS RULE: If checking out on a fresh calendar cell day without checking in,
        // initialize a safe modern record layout containing their work notes summary straight away
        record = new Attendance({
          employeeId,
          employeeName,
          dateString: todayStr,
          checkOut: now,
          workSummary: workSummary || "Logged checkout directly.",
          status: "Completed",
        });
        extraDetailsHtml = `
          <div class="data-row"><span class="label">Shift Status</span><span class="value" style="color:#64748b; font-weight:700;">Completed</span></div>
        `;
      } else {
        record.checkOut = now;
        record.workSummary = workSummary || ""; // Save user text input safely into DB row instance

        if (record.checkIn) {
          const diffMs = record.checkOut - record.checkIn;
          record.totalMinutes = Math.floor(diffMs / 1000 / 60);

          const workedHours = Math.floor(record.totalMinutes / 60);
          const workedRemMins = record.totalMinutes % 60;
          durationStr = `${workedHours}h ${workedRemMins}m`;

          // ⏱️ STANDARD SHIFT DURATION: 7 hours 30 minutes = 450 total minutes
          const standardWorkMins = 450;
          const varianceMins = record.totalMinutes - standardWorkMins;

          const estimatedEst = new Date(
            record.checkIn.getTime() + 7.5 * 60 * 60 * 1000,
          );
          const estimatedCheckoutStr = estimatedEst.toLocaleTimeString([], {
            hour: "2-digit",
            minute: "2-digit",
          });

          if (record.totalMinutes >= standardWorkMins) {
            const overtimeMins = record.totalMinutes - standardWorkMins;
            const otH = Math.floor(overtimeMins / 60);
            const otM = overtimeMins % 60;
            statusStr = `Full Day (+${otH}h ${otM}m Overtime)`;
            statusColor = "#10b981";

            extraDetailsHtml = `
              <div class="data-row"><span class="label">Total Work Duration</span><span class="value" style="font-weight:700; color:#10b981;">${durationStr}</span></div>
              <div class="data-row"><span class="label">Shift Status</span><span class="value" style="color:${statusColor}; font-weight:700;">${statusStr}</span></div>
            `;
          } else {
            // ⚠️ SHORTFALL CALCULATION (< 450 minutes / 7.30 hours)
            const shortMins = standardWorkMins - record.totalMinutes;
            const shortHours = Math.floor(shortMins / 60);
            const shortRemMins = shortMins % 60;
            const shortFormattedStr = `${shortHours}h ${shortRemMins}m`;

            // Required Status Format: -Xh Ym Short/Early in bold red (#ef4444)
            statusStr = `-${shortHours}h ${shortRemMins}m Short/Early`;
            statusColor = "#ef4444";

            // 🔔 Native Browser Popup Alert Injection
            alertScriptHtml = `
              <script>
                alert("⚠️ INCOMPLETE SHIFT WARNING\\n\\nYou are checking out ${shortHours} hour(s) and ${shortRemMins} minute(s) before completing your required 7 hours 30 minutes shift.\\n\\nTotal Worked: ${workedHours} hour(s) ${workedRemMins} minute(s).");
              </script>
            `;

            // On-screen Warning Banner HTML
            warningBannerHtml = `
              <div style="background:#fef2f2; border:1px solid #fca5a5; border-radius:14px; padding:14px; margin-bottom:18px; text-align:left;">
                  <div style="display:flex; align-items:center; gap:8px; margin-bottom:4px;">
                      <span style="font-size:18px;">⚠️</span>
                      <span style="font-size:14px; font-weight:700; color:#dc2626;">Incomplete Shift Warning</span>
                  </div>
                  <p style="font-size:13px; color:#991b1b; margin:0; line-height:1.4;">
                      You are checking out <b>${shortFormattedStr}</b> before completing your required 7 hours 30 minutes shift.
                  </p>
              </div>`;

            extraDetailsHtml = `
              <div class="data-row"><span class="label">Total Worked</span><span class="value" style="font-weight:700;">${durationStr}</span></div>
              <div class="data-row"><span class="label">Est. Checkout (7h 30m)</span><span class="value">${estimatedCheckoutStr}</span></div>
              <div class="data-row"><span class="label">Time Shortfall</span><span class="value" style="color:#ef4444; font-weight:700;">${shortFormattedStr} needed</span></div>
              <div class="data-row"><span class="label">Shift Status</span><span class="value" style="color:${statusColor}; font-weight:700;">${statusStr}</span></div>
            `;
          }
        } else {
          extraDetailsHtml = `
            <div class="data-row"><span class="label">Shift Status</span><span class="value" style="color:#64748b; font-weight:700;">Completed</span></div>
          `;
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
                  ${warningBannerHtml}
                  <div class="icon" style="color:#ea580c;">✓</div>
                  <h2>Shift Completed</h2>
                  <p>Good job today, <b>${employeeName}</b>! Your departure has been logged.</p>
                  <div class="data-table">
                      <div class="data-row"><span class="label">Name</span><span class="value" style="color:#ea580c;">${employeeName}</span></div>
                      <div class="data-row"><span class="label">Employee ID</span><span class="value">${employeeId.toUpperCase()}</span></div>
                      <div class="data-row"><span class="label">Checked Out</span><span class="value">${checkOutTimeStr}</span></div>
                      ${extraDetailsHtml}
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
                body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #f8fafc; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; padding: 20px 0; }
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
            ${alertScriptHtml}

            <script>
                localStorage.setItem('teche_saved_id', "${employeeId.toLowerCase().trim()}");
                localStorage.setItem('teche_saved_name', "${employeeName}");
                setTimeout(function() {
                    window.location.href = "/";
                }, 4000);
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

// 🔐 ADMIN AUTHENTICATION ROUTE
app.post("/api/admin/login", (req, res) => {
  const { username, password } = req.body;
  if (username === "itadmin" && password === "itadmin@teche") {
    return res.json({ success: true, token: "admin-auth-token" });
  } else {
    return res
      .status(401)
      .json({ success: false, message: "Invalid username or password." });
  }
});

// ⚙️ ADMIN MANUAL ATTENDANCE OVERRIDE ROUTE
app.post("/api/admin/attendance/manual", async (req, res) => {
  try {
    const {
      employeeId,
      dateString,
      checkInTime,
      checkOutTime,
      workSummary,
      status,
    } = req.body;

    if (!employeeId || !dateString) {
      return res
        .status(400)
        .json({
          success: false,
          message: "Employee ID and Date are required.",
        });
    }

    const cleanEmpId = employeeId.toLowerCase().trim();
    const employeeName = getEmployeeName(cleanEmpId);

    let checkIn = null;
    if (checkInTime) {
      checkIn = new Date(`${dateString}T${checkInTime}:00`);
      if (isNaN(checkIn.getTime())) checkIn = null;
    }

    let checkOut = null;
    if (checkOutTime) {
      checkOut = new Date(`${dateString}T${checkOutTime}:00`);
      if (isNaN(checkOut.getTime())) checkOut = null;
    }

    let totalMinutes = 0;
    if (checkIn && checkOut) {
      const diffMs = checkOut.getTime() - checkIn.getTime();
      totalMinutes = diffMs > 0 ? Math.floor(diffMs / 1000 / 60) : 0;
    }

    let record = await Attendance.findOne({
      employeeId: cleanEmpId,
      dateString,
    });

    if (record) {
      record.employeeName = employeeName;
      if (checkIn) record.checkIn = checkIn;
      if (checkOut) record.checkOut = checkOut;
      record.workSummary =
        workSummary || record.workSummary || "Manual entry override";
      record.status = status || "Completed";
      record.totalMinutes = totalMinutes;
      record.isManualEntry = true;
      await record.save();
    } else {
      record = new Attendance({
        employeeId: cleanEmpId,
        employeeName,
        dateString,
        checkIn,
        checkOut,
        workSummary: workSummary || "Manual entry override",
        status: status || "Completed",
        totalMinutes,
        isManualEntry: true,
      });
      await record.save();
    }

    return res.json({
      success: true,
      message: "Manual attendance record processed successfully.",
      record,
    });
  } catch (error) {
    console.error("❌ Error processing manual attendance override:", error);
    return res
      .status(500)
      .json({ success: false, message: "Internal server error." });
  }
});

const PORT = 8080;
const LOCAL_IP = "192.168.1.59"; // Verified local laptop network IP

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
