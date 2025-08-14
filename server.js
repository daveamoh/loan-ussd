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
  {
    db: { schema: 'public' }
  }
);

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY,
  {
    db: { schema: 'public' }
  }
);

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Server error:', err);
  res.status(500).json({ 
    MSG: "System error. Please try again later.",
    MSGTYPE: false 
  });
});

// USSD endpoint
app.post('/ussd', async (req, res) => {
  const { USERID, MSISDN, USERDATA, MSGTYPE, NETWORK, SESSIONID } = req.body;
  
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
    
    res.json(response);
  } catch (error) {
    console.error('USSD processing error:', error);
    res.status(500).json({
      USERID: USERID,
      MSISDN: MSISDN,
      MSG: "Service temporarily unavailable. Please try again later.",
      MSGTYPE: false
    });
  }
});

// Helper functions
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
  const { data: user, error } = await supabase
    .from('users')
    .select('*')
    .eq('phone', msisdn)
    .single();
  
  if (error || !user) {
    response.MSG = `Welcome to Quick Loans\n1. Register\n2. About\n3. Exit`;
  } else {
    // Check if user has active loans to modify menu
    const { data: activeLoans } = await supabase
      .from('loans')
      .select('*')
      .eq('user_id', msisdn)
      .eq('status', 'active');
    
    if (activeLoans && activeLoans.length > 0) {
      const totalOwed = activeLoans.reduce((sum, loan) => sum + loan.amount, 0);
      response.MSG = `Welcome back ${user.name}\nYou owe GHS ${totalOwed}\n2. Repay Loan\n3. Check Balance\n4. Exit`;
    } else {
      response.MSG = `Welcome back ${user.name}\n1. Request Loan\n2. Repay Loan\n3. Check Balance\n4. Exit`;
    }
  }
  
  return response;
}

const registrationStates = {};
const loanStates = {};
const repaymentStates = {};

async function handleRegistrationFlow(msisdn, input, response) {
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
        
        response.MSG = `Registration successful ${registration.name}!\n1. Request Loan\n2. Repay Loan\n3. Check Balance\n4. Exit`;
        delete registrationStates[msisdn];
      } catch (err) {
        console.error('Registration failed:', err);
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

async function processUserInput(msisdn, userData, response) {
  const input = userData.trim();
  const { data: user, error } = await supabase
    .from('users')
    .select('*')
    .eq('phone', msisdn)
    .single();
  
  if (error || !user) {
    return handleRegistrationFlow(msisdn, input, response);
  } else {
    return handleLoanOperations(msisdn, input, user, response);
  }
}

async function handleLoanOperations(msisdn, input, user, response) {
  // Check repayment flow first
  if (repaymentStates[msisdn]) {
    return handleRepaymentFlow(msisdn, input, response);
  }

  // Check loan selection flow
  if (loanStates[msisdn] && loanStates[msisdn].step === 'select_amount') {
    return handleLoanAmountSelection(msisdn, input, user, response);
  }

  switch (input) {
    case '1': // Request Loan
      const { data: activeLoans, error: loanCheckError } = await supabase
        .from('loans')
        .select('*')
        .eq('user_id', msisdn)
        .eq('status', 'active');
      
      if (loanCheckError) {
        response.MSG = 'Error checking your loan status';
        break;
      }
      
      if (activeLoans && activeLoans.length > 0) {
        const totalOwed = activeLoans.reduce((sum, loan) => sum + loan.amount, 0);
        response.MSG = `You already have an active loan of GHS ${totalOwed}.\nPlease repay before taking a new loan.\n2. Repay Loan\n3. Check Balance\n4. Exit`;
      } else {
        loanStates[msisdn] = { step: 'select_amount' };
        response.MSG = 'Select loan amount:\n1. GHS 100\n2. GHS 200\n3. GHS 500\n4. Other amount';
      }
      break;
      
    case '2': // Repay Loan
      return initiateRepayment(msisdn, response);
      
    case '3': // Check Balance
      const { data: loans, error: loanError } = await supabase
        .from('loans')
        .select('*')
        .eq('user_id', msisdn);
      
      if (loanError) {
        response.MSG = 'Error fetching loan details';
      } else {
        const activeLoans = loans.filter(loan => loan.status === 'active');
        const totalOwed = activeLoans.reduce((sum, loan) => sum + loan.amount, 0);
        
        if (activeLoans.length === 0) {
          response.MSG = 'You have no active loans.';
        } else {
          response.MSG = `Active loans: ${activeLoans.length}\nTotal owed: GHS ${totalOwed}`;
        }
      }
      break;
      
    case '4': // Exit
      response.MSG = 'Thank you for using Quick Loans';
      response.MSGTYPE = false;
      break;
      
    default:
      const { data: userLoans } = await supabase
        .from('loans')
        .select('*')
        .eq('user_id', msisdn)
        .eq('status', 'active');
      
      if (userLoans && userLoans.length > 0) {
        response.MSG = 'Invalid selection\n2. Repay Loan\n3. Check Balance\n4. Exit';
      } else {
        response.MSG = 'Invalid selection\n1. Request Loan\n2. Repay Loan\n3. Check Balance\n4. Exit';
      }
  }
  
  return response;
}

async function initiateRepayment(msisdn, response) {
  const { data: activeLoans, error } = await supabase
    .from('loans')
    .select('*')
    .eq('user_id', msisdn)
    .eq('status', 'active');
  
  if (error || !activeLoans || activeLoans.length === 0) {
    response.MSG = 'You have no active loans to repay.';
    return response;
  }

  const totalOwed = activeLoans.reduce((sum, loan) => sum + loan.amount, 0);
  repaymentStates[msisdn] = {
    step: 'select_amount',
    loans: activeLoans,
    totalOwed: totalOwed
  };
  
  response.MSG = `You owe GHS ${totalOwed}\nEnter amount to repay:`;
  return response;
}

async function handleRepaymentFlow(msisdn, input, response) {
  const repayment = repaymentStates[msisdn];
  
  if (!repayment) {
    response.MSG = 'Repayment session expired. Please start again.';
    response.MSGTYPE = false;
    return response;
  }

  const amount = parseFloat(input);
  if (isNaN(amount) || amount <= 0) {
    response.MSG = 'Invalid amount. Please enter a positive number:';
    return response;
  }

  if (amount > repayment.totalOwed) {
    response.MSG = `Amount exceeds debt (GHS ${repayment.totalOwed}).\nEnter correct amount:`;
    return response;
  }

  try {
    // Record payment
    const { data: payment, error: paymentError } = await supabase
      .from('payments')
      .insert({
        user_id: msisdn,
        amount: amount,
        status: 'completed'
      })
      .select();

    if (paymentError) throw paymentError;

    // Update loan status
    if (amount === repayment.totalOwed) {
      await supabase
        .from('loans')
        .update({ status: 'paid' })
        .eq('user_id', msisdn)
        .eq('status', 'active');
    } else {
      // For partial payment, update the first loan (simplified logic)
      await supabase
        .from('loans')
        .update({ 
          amount: repayment.loans[0].amount - amount,
          status: repayment.loans[0].amount - amount <= 0 ? 'paid' : 'active'
        })
        .eq('id', repayment.loans[0].id);
    }

    delete repaymentStates[msisdn];
    response.MSG = `Payment of GHS ${amount} received!\n1. Main Menu\n2. Exit`;
    response.MSGTYPE = true;
  } catch (err) {
    console.error('Payment processing error:', err);
    response.MSG = 'Payment failed. Please try again later.';
    response.MSGTYPE = false;
  }

  return response;
}

async function handleLoanAmountSelection(msisdn, input, user, response) {
  const loanState = loanStates[msisdn];
  let amount = 0;
  
  if (loanState.waitingForCustomAmount) {
    if (!isNaN(input) && parseFloat(input) > 0) {
      amount = parseFloat(input);
    } else {
      response.MSG = 'Invalid amount. Please enter a positive number:';
      return response;
    }
  } else {
    switch (input) {
      case '1':
        amount = 100;
        break;
      case '2':
        amount = 200;
        break;
      case '3':
        amount = 500;
        break;
      case '4':
        loanStates[msisdn].waitingForCustomAmount = true;
        response.MSG = 'Enter custom loan amount (GHS):';
        return response;
      default:
        response.MSG = 'Invalid selection\n1. GHS 100\n2. GHS 200\n3. GHS 500\n4. Other amount';
        return response;
    }
  }

  try {
    const { data: loan, error } = await supabase
      .from('loans')
      .insert({
        user_id: msisdn,
        amount: amount,
        status: 'pending',
        due_date: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) // 30 days from now
      })
      .select();

    if (error) throw error;

    delete loanStates[msisdn];

    response.MSG = `Loan request of GHS ${amount} received!\nWe will process your request shortly.\n1. Main Menu\n2. Exit`;
    response.MSGTYPE = true;
  } catch (err) {
    console.error('Loan processing error:', err);
    response.MSG = 'Loan processing failed. Please try again later.';
    response.MSGTYPE = false;
  }

  return response;
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`USSD server running on port ${PORT}`);
  console.log('Supabase connected to schema: public');
});