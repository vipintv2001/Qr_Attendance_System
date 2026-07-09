const express = require("express");
const path = require("path");
const cors = require("cors");
const fetch = require("node-fetch");
const fs = require("fs");

const app = express();
app.use(cors());
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ limit: "10mb", extended: true }));

app.use(express.static(path.join(__dirname, "public")));

const REGISTRY_FILE = path.join(__dirname, "device_registry.json");
const SHIFT_FILE = path.join(__dirname, "shift_registry.json");
const EMPLOYEE_FILE = path.join(__dirname, "employees.json"); // 👥 Our new employee directory list reference

// Helpers for files
const getDeviceRegistry = () =>
  fs.existsSync(REGISTRY_FILE)
    ? JSON.parse(fs.readFileSync(REGISTRY_FILE))
    : {};
const saveDeviceRegistry = (data) =>
  fs.writeFileSync(REGISTRY_FILE, JSON.stringify(data, null, 2));
const getShiftRegistry = () =>
  fs.existsSync(SHIFT_FILE) ? JSON.parse(fs.readFileSync(SHIFT_FILE)) : {};
const saveShiftRegistry = (data) =>
  fs.writeFileSync(SHIFT_FILE, JSON.stringify(data, null, 2));

// Helper to look up employee names locally
const getEmployeeName = (empId) => {
  if (!fs.existsSync(EMPLOYEE_FILE)) return "Team Member";
  const directory = JSON.parse(fs.readFileSync(EMPLOYEE_FILE));
  return directory[empId.toLowerCase()] || "Team Member";
};

app.post("/api/attendance", async (req, res) => {
  const { employeeId, attendanceAction, deviceToken } = req.body;

  if (!employeeId || !deviceToken) {
    return res.status(400).send("Missing parameters.");
  }

  const registry = getDeviceRegistry();
  const shiftLog = getShiftRegistry();
  const now = new Date();

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

  // ⏱️ SHIFT CALCULATION & RESPONSE VIEW GENERATION
  let responseHtml = "";

  if (attendanceAction === "Check-In") {
    shiftLog[employeeId] = now.toISOString();
    saveShiftRegistry(shiftLog);

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
    const checkInTimeRaw = shiftLog[employeeId];
    let durationStr = "--";
    let statusStr = "Completed";
    let statusColor = "#64748b";

    if (checkInTimeRaw) {
      const timeIn = new Date(checkInTimeRaw);
      const diffMs = now - timeIn;
      const totalSecs = Math.floor(diffMs / 1000);

      const hours = Math.floor(totalSecs / 3600);
      const minutes = Math.floor((totalSecs % 3600) / 60);
      durationStr = `${hours}h ${minutes}m`;

      const standardWorkSecs = 8 * 60 * 60;
      const varianceSecs = totalSecs - standardWorkSecs;
      const varHours = Math.floor(Math.abs(varianceSecs) / 3600);
      const varMins = Math.floor((Math.abs(varianceSecs) % 3600) / 60);

      if (varianceSecs >= 0) {
        statusStr = `+${varHours}h ${varMins}m Overtime`;
        statusColor = "#10b981";
      } else {
        statusStr = `-${varHours}h ${varMins}m Short/Early`;
        statusColor = "#ef4444";
      }

      delete shiftLog[employeeId];
      saveShiftRegistry(shiftLog);
    } else {
      durationStr = "Unknown (Missing Check-In)";
      statusStr = "Untracked Shift duration";
    }

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
                  <div class="data-row"><span class="label">Clocked Out</span><span class="value">${checkOutTimeStr}</span></div>
                  <div class="data-row"><span class="label">Total Duration</span><span class="value" style="font-weight:700;">${durationStr}</span></div>
                  <div class="data-row"><span class="label">Shift Status</span><span class="value" style="color:${statusColor}; font-weight:700;">${statusStr}</span></div>
              </div>
          </div>`;
  }

  // 🚀 POST PIPELINE TO GOOGLE FORM CONTAINER
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
        </body>
        </html>
    `);
  } catch (error) {
    res.status(500).send("Database sync error.");
  }
});

const PORT = 8080;
app.listen(PORT, () => {
  console.log(`🚀 Attendance system online on port ${PORT}`);
});
