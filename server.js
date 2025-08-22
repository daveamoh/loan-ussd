require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const { createClient } = require('@supabase/supabase-js');
const bcrypt = require('bcryptjs');

const app = express();
app.use(bodyParser.json());

// Initialize Supabase clients
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY,
  { db: { schema: 'public' } }
);

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY,
  { db: { schema: 'public' } }
);

// ========== Logging Middleware ==========

// Log all incoming requests
app.use((req, res, next) => {
  console.log(`\n=== Incoming Request ===`);
  console.log(`Time: ${new Date().toISOString()}`);
  console.log(`Method: ${req.method}`);
  console.log(`URL: ${req.originalUrl}`);
  console.log(`Headers:`, req.headers);
  console.log(`Body:`, req.body);
  console.log(`========================`);
  next();
});

// Log all outgoing responses
app.use((req, res, next) => {
  const oldJson = res.json;
  res.json = function (data) {
    console.log(`\n>>> Outgoing Response <<<`);
    console.log(`Time: ${new Date().toISOString()}`);
    console.log(`Status: ${res.statusCode}`);
    console.log(`Body:`, data);
    console.log(`==========================`);
    return oldJson.apply(res, arguments);
  };
  next();
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Server error:', err);
  res.status(500).json({ 
    MSG: "System error. Please try again later.",
    MSGTYPE: false 
  });
});

// ========== USSD Endpoint ==========
app.post('/ussd', async (req, res) => {
  const { USERID, MSISDN, USERDATA, MSGTYPE, NETWORK, SESSIONID } = req.body;
  console.log("📲 USSD Request Body:", req.body);

  try {
    if (!validateGhanaPhoneNumber(MSISDN)) {
      return res.json({
        USERID,
        MSISDN,
        MSG: "Invalid phone number format. Please use a Ghanaian number starting with 233.",
        MSGTYPE: false
      });
    }

    const response = await handleUSSDRequest({
      userId: USERID,
      msisdn: MSISDN,
      userData: USERDATA,
      msgType: MSGTYPE,
      network: NETWORK,
      sessionId: SESSIONID
    });

    console.log("📤 USSD Response:", response);
    res.json(response);
  } catch (error) {
    console.error('❌ USSD processing error:', error);
    res.status(500).json({
      USERID: USERID,
      MSISDN: MSISDN,
      MSG: "Service temporarily unavailable. Please try again later.",
      MSGTYPE: false
    });
  }
});

// ========== Helper Functions ==========
function validateGhanaPhoneNumber(phone) {
  return /^233\d{9}$/.test(phone);
}

function validateGhanaCardNumber(cardNumber) {
  return /^GHA-\d{9}-\d{1}$/.test(cardNumber);
}

async function handleUSSDRequest({ userId, msisdn, userData, msgType, network, sessionId }) {
  let response = {
    USERID: userId,
    MSISDN: msisdn,
    MSGTYPE: true
  };

  if (msgType) {
    return await handleFirstRequest(msisdn, response);
  }

  return await processUserInput(msisdn, userData, response);
}

async function handleFirstRequest(msisdn, response) {
  console.log("🔍 Checking user in Supabase:", msisdn);

  const { data: user, error } = await supabase
    .from('users')
    .select('*')
    .eq('phone', msisdn)
    .single();

  if (error) console.error("❌ Supabase error fetching user:", error);
  else console.log("✅ User fetched:", user);

  if (error || !user) {
    response.MSG = `Welcome to Quick Loans\n1. Register\n2. About\n3. Exit`;
  } else {
    const { data: activeLoans } = await supabase
      .from('loans')
      .select('*')
      .eq('user_id', msisdn)
      .eq('status', 'active');

    console.log("💰 Active loans for user:", activeLoans);

    if (activeLoans && activeLoans.length > 0) {
      const totalOwed = activeLoans.reduce((sum, loan) => sum + loan.amount, 0);
      response.MSG = `Welcome back ${user.name}\nYou owe GHS ${totalOwed}\n2. Repay Loan\n3. Check Balance\n4. Exit`;
    } else {
      response.MSG = `Welcome back ${user.name}\n1. Request Loan\n2. Repay Loan\n3. Check Balance\n4. Exit`;
    }
  }
  
  return response;
}

// ========== State Tracking ==========
const registrationStates = {};
const loanStates = {};
const repaymentStates = {};

async function handleRegistrationFlow(msisdn, input, response) {
  console.log(`👤 Registration flow for ${msisdn}, step:`, registrationStates[msisdn]);

  if (!registrationStates[msisdn]) {
    if (input === '1') {
      registrationStates[msisdn] = { step: 'name' };
      response.MSG = 'Enter your full name:';
    } else if (input === '2') {
      response.MSG = 'Quick Loans - Affordable micro loans\nDial *123# to get started';
      response.MSGTYPE = false;
    } else if (input === '3') {
      response.MSG = 'Thank you for using Quick Loans';
      response.MSGTYPE = false;
    } else {
      response.MSG = 'Invalid selection\n1. Register\n2. About\n3. Exit';
    }
    return response;
  }

  const registration = registrationStates[msisdn];
  
  switch (registration.step) {
    case 'name':
      if (!input || input.length < 3) {
        response.MSG = 'Invalid name. Please enter your full name (min 3 characters):';
        return response;
      }
      registration.name = input;
      registration.step = 'ghana_card';
      response.MSG = 'Enter your Ghana Card number (format: GHA-123456789-0):';
      break;
      
    case 'ghana_card':
      if (!input || !validateGhanaCardNumber(input)) {
        response.MSG = 'Invalid Ghana Card number. Format: GHA-123456789-0\nPlease enter again:';
        return response;
      }
      registration.ghana_card = input;
      registration.step = 'pin';
      response.MSG = 'Create a 4-digit PIN:';
      break;
      
    case 'pin':
      if (input.length !== 4 || isNaN(input)) {
        response.MSG = 'Invalid PIN. Please enter a 4-digit number:';
        return response;
      }

      try {
        const pinHash = await bcrypt.hash(input, 10);
        console.log("🔑 Storing user with hashed PIN");

        const { data, error } = await supabaseAdmin
          .from('users')
          .upsert({
            phone: msisdn,
            name: registration.name,
            ghana_card: registration.ghana_card,
            pin: pinHash
          })
          .select();

        if (error) throw error;

        console.log("✅ User registered:", data);

        response.MSG = `Registration successful ${registration.name}!\n1. Request Loan\n2. Repay Loan\n3. Check Balance\n4. Exit`;
        delete registrationStates[msisdn];
      } catch (err) {
        console.error('❌ Registration failed:', err);
        response.MSG = 'Registration failed. Phone number or Ghana Card may already be registered.';
        response.MSGTYPE = false;
      }
      break;
      
    default:
      response.MSG = 'Session expired. Please start again.';
      delete registrationStates[msisdn];
      response.MSGTYPE = false;
  }
  
  return response;
}

// ========= Other flows (Loans, Repayments) remain same =========
// (Keep your existing functions but add console.log() in the same style 
// wherever Supabase queries and state updates happen)

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 USSD server running on port ${PORT}`);
  console.log('🔗 Supabase connected to schema: public');
});
