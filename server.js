const express = require('express');
const bodyParser = require('body-parser');
const { v4: uuidv4 } = require('uuid');

const app = express();
app.use(bodyParser.json());

/**
 * Simple phone number validation for Ghana
 */
function validateGhanaPhoneNumber(msisdn) {
  const regex = /^233[0-9]{9}$/; // Ghana MSISDN format
  return regex.test(msisdn);
}

// ----------------- STATE MANAGEMENT -----------------
const sessions = {}; // Store all session states by SESSIONID

/**
 * Handle USSD requests based on state
 */
async function handleUSSDRequest({ userId, msisdn, userData, msgType, network, sessionId }) {
  if (!sessions[sessionId]) {
    sessions[sessionId] = {
      step: 0,
      flow: null,
      data: {}
    };
  }

  const state = sessions[sessionId];

  // 🌍 If it's a new session or first input
  if (state.step === 0 && msgType === true) {
    state.step = 1;
    return {
      MSISDN: msisdn,
      MSG: "Welcome to Quick Loans\n1. Register\n2. About\n3. Exit",
      MSGTYPE: true
    };
  }

  // 🌍 Handle menu navigation
  if (state.flow === null) {
    switch (userData.trim()) {
      case "1":
        state.flow = "registration";
        state.step = 1;
        return { MSISDN: msisdn, MSG: "Enter your full name:", MSGTYPE: true };
      case "2":
        return { MSISDN: msisdn, MSG: "Quick Loans offers instant loans. Dial again to continue.", MSGTYPE: false };
      case "3":
        return { MSISDN: msisdn, MSG: "Thank you for using Quick Loans. Goodbye!", MSGTYPE: false };
      default:
        return { MSISDN: msisdn, MSG: "Invalid option. Try again.\n1. Register\n2. About\n3. Exit", MSGTYPE: true };
    }
  }

  // 🌍 Registration flow
  if (state.flow === "registration") {
    if (state.step === 1) {
      state.data.name = userData.trim();
      state.step = 2;
      return { MSISDN: msisdn, MSG: "Enter your date of birth (DD/MM/YYYY):", MSGTYPE: true };
    } else if (state.step === 2) {
      state.data.dob = userData.trim();
      state.step = 3;
      return { MSISDN: msisdn, MSG: "Enter your National ID number:", MSGTYPE: true };
    } else if (state.step === 3) {
      state.data.id = userData.trim();
      state.flow = null;
      state.step = 0;
      return { MSISDN: msisdn, MSG: "Registration successful! Thank you.", MSGTYPE: false };
    }
  }

  // Fallback
  return { MSISDN: msisdn, MSG: "Invalid input. Please try again.", MSGTYPE: true };
}

// ----------------- ENDPOINT -----------------
app.post('/ussd', async (req, res) => {
  let { USERID, MSISDN, USERDATA, MSGTYPE, NETWORK, SESSIONID } = req.body;
  console.log("📲 Incoming USSD Request:", req.body);

  try {
    // Always generate USERID if not provided
    USERID = USERID || `USER-${MSISDN}`;

    // Generate SESSIONID if not provided
    SESSIONID = SESSIONID || uuidv4();

    if (!validateGhanaPhoneNumber(MSISDN)) {
      return res.json({
        USERID,
        MSISDN,
        SESSIONID,
        MSG: "Invalid phone number format. Please use a Ghanaian number starting with 233.",
        MSGTYPE: false
      });
    }

    const response = await handleUSSDRequest({
      userId: USERID,
      msisdn: MSISDN,
      userData: USERDATA || "",
      msgType: MSGTYPE,
      network: NETWORK,
      sessionId: SESSIONID
    });

    response.USERID = USERID;
    response.SESSIONID = SESSIONID;

    console.log("📤 USSD Response:", response);
    res.json(response);
  } catch (error) {
    console.error("❌ USSD processing error:", error);
    res.status(500).json({
      USERID,
      MSISDN,
      SESSIONID,
      MSG: "Service temporarily unavailable. Please try again later.",
      MSGTYPE: false
    });
  }
});

// ----------------- START SERVER -----------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 USSD server running on port ${PORT}`);
});
