const mongoose = require("mongoose");

const AttendanceSchema = new mongoose.Schema(
  {
    // Holds the unique employee ID identifier string (e.g., 'teche1001')
    employeeId: {
      type: String,
      required: true,
      lowercase: true,
      trim: true,
    },
    // Holds the human-readable full name fetched from your directory registry
    employeeName: {
      type: String,
      required: true,
    },
    // Pure date string format 'YYYY-MM-DD' makes it incredibly easy to query,
    // filter, and group attendance logs by month in your admin dashboard.
    dateString: {
      type: String,
      required: true,
    },
    // Stores the exact timestamp when the employee clicked 'Check-In'
    checkIn: {
      type: Date,
    },
    // Stores the exact timestamp when the employee clicked 'Check-Out'
    checkOut: {
      type: Date,
    },
    // Stores the calculated running difference between check-in and check-out
    totalMinutes: {
      type: Number,
      default: 0,
    },
    workSummary: { type: String, default: "" },
  },
  {
    // Automatically appends data creation records (createdAt, updatedAt) fields
    timestamps: true,
  },
);

// Creates an index optimization layer to make searches by date and employee lightning-fast
AttendanceSchema.index({ employeeId: 1, dateString: 1 });

module.exports = mongoose.model("Attendance", AttendanceSchema);
