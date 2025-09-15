// server.js
import express from "express";
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";

dotenv.config();

const app = express();
app.use(express.json());

// ── Config ──────────────────────────────────────────────────────────────
// Loan configuration
const INTEREST_RATE = parseFloat(process.env.INTEREST_RATE || "0.10"); // 10% simple interest
const LOAN_TERM_DAYS = parseInt(process.env.LOAN_TERM_DAYS || "30", 10); // due date helper
const MIN_LOAN_AMOUNT = 10; // Minimum loan amount in GHS
const MAX_LOAN_AMOUNT = 1000; // Maximum loan amount in GHS
const LOAN_PROCESSING_MESSAGE = "Your application is being processed. You'll receive an SMS confirmation shortly.";

// ── Supabase ────────────────────────────────────────────────────────────
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

function money(n) {
  // always 2dp
  return Number.parseFloat(n).toFixed(2);
}

function addDays(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10); // YYYY-MM-DD
}

// ── USSD Endpoint ───────────────────────────────────────────────────────
app.post("/ussd", async (req, res) => {
  try {
    const { MSISDN, USERDATA } = req.body;

    if (!MSISDN) {
      return res.status(400).json({ MSG: "Missing MSISDN", MSGTYPE: false });
    }

    // Fetch or create session
    let { data: sessions, error: sErr } = await supabase
      .from("ussd_sessions")
      .select("*")
      .eq("msisdn", MSISDN)
      .limit(1);

    if (sErr) throw sErr;

    let session = sessions?.[0];
    if (!session) {
      const { data, error } = await supabase
        .from("ussd_sessions")
        .insert([{ msisdn: MSISDN, step: 0, data: {} }])
        .select()
        .single();
      if (error) throw error;
      session = data;
    }

    let responseMsg = "";
    let continueSession = true;

    // Helper: get user (if exists)
    const { data: users } = await supabase
      .from("users")
      .select("*")
      .eq("msisdn", MSISDN)
      .limit(1);
    const user = users?.[0];

    switch (session.step) {
      // Main menu
      case 0: {
        responseMsg =
          "Welcome to sika loan\n1. Register\n2. Apply for Loan\n3. Repay Loan\n4. Check Balance\n5. About\n6. Exit";
        await supabase.from("ussd_sessions").update({ step: 1 }).eq("id", session.id);
        break;
      }

      // Handle main menu choice
      case 1: {
        if (USERDATA === "1") {
          responseMsg = "Enter your full name:";
          await supabase.from("ussd_sessions").update({ step: 2, data: {} }).eq("id", session.id);

        } else if (USERDATA === "2") {
          if (!user) {
            responseMsg = "You must register first!";
            continueSession = false;
          } else {
            // Prevent multiple loans
            const { data: activeLoans } = await supabase
              .from("loans")
              .select("id")
              .eq("user_id", user.id)
              .eq("status", "active")
              .limit(1);

            if (activeLoans?.length) {
              responseMsg = "You already have an active loan. Repay before applying again.";
              continueSession = false;
            } else {
              responseMsg = "Enter loan amount (GHS):";
              await supabase
                .from("ussd_sessions")
                .update({ step: 10, data: { userId: user.id } })
                .eq("id", session.id);
            }
          }

        } else if (USERDATA === "3") {
          if (!user) {
            responseMsg = "You must register first!";
            continueSession = false;
          } else {
            // fetch active loan
            const { data: loan } = await supabase
              .from("loans")
              .select("*")
              .eq("user_id", user.id)
              .eq("status", "active")
              .maybeSingle();

            if (!loan) {
              responseMsg = "No active loan found.";
              continueSession = false;
            } else {
              responseMsg =
                `Outstanding: GHS ${money(loan.balance)} (Total Due: GHS ${money(loan.total_due)})\n` +
                `Enter amount to repay:`;
              await supabase
                .from("ussd_sessions")
                .update({ step: 20, data: { loanId: loan.id } })
                .eq("id", session.id);
            }
          }

        } else if (USERDATA === "4") {
          if (!user) {
            responseMsg = "You must register first!";
            continueSession = false;
          } else {
            const { data: loan } = await supabase
              .from("loans")
              .select("*")
              .eq("user_id", user.id)
              .eq("status", "active")
              .maybeSingle();

            if (!loan) {
              responseMsg = "No active loan. Balance: GHS 0.00";
            } else {
              responseMsg =
                `Loan Summary\n` +
                `Principal: GHS ${money(loan.principal)}\n` +
                `Interest (${(loan.interest_rate * 100).toFixed(2)}%): GHS ${money(loan.interest_amount)}\n` +
                `Total Due: GHS ${money(loan.total_due)}\n` +
                `Outstanding: GHS ${money(loan.balance)}\n` +
                (loan.due_date ? `Due: ${loan.due_date}` : "");
            }
            continueSession = false;
          }

        } else if (USERDATA === "5") {
          responseMsg = "sika loan: simple microloans with transparent interest.";
          continueSession = false;

        } else if (USERDATA === "6") {
          responseMsg = "Thank you for using sika loan. Goodbye!";
          continueSession = false;

        } else {
          responseMsg =
            "Invalid choice. Try again.\n1. Register\n2. Apply for Loan\n3. Repay Loan\n4. Check Balance\n5. About\n6. Exit";
        }
        break;
      }

      // Registration flow
      case 2: {
        // Validate name (basic check for at least 2 words with letters only)
        const nameRegex = /^[A-Za-z]+(?:\s+[A-Za-z]+)+$/;
        if (!nameRegex.test(USERDATA.trim())) {
          responseMsg = "❌ Please enter your full name (at least first and last name, letters only):";
          break;
        }
        
        responseMsg = "Enter your date of birth (DDMMYYYY, e.g., 15091990 for 15th September 1990):";
        await supabase
          .from("ussd_sessions")
          .update({ step: 3, data: { ...session.data, name: USERDATA.trim() } })
          .eq("id", session.id);
        break;
      }

      // Registration flow - Step 3: Get date of birth and validate
      case 3: {
        // Validate date of birth format (DDMMYYYY)
        const dobRegex = /^(0[1-9]|[12][0-9]|3[01])(0[1-9]|1[0-2])(19|20)\d{2}$/;
        if (!dobRegex.test(USERDATA)) {
          responseMsg = "❌ Invalid date format. Please enter date of birth as DDMMYYYY (e.g., 15091990 for 15th September 1990):";
          break;
        }
        
        // Ask for ID type
        responseMsg = "Select ID type:\n1. National ID\n2. Passport\n3. Driver's License";
        await supabase
          .from("ussd_sessions")
          .update({ step: 4, data: { ...session.data, dob: USERDATA } })
          .eq("id", session.id);
        break;
      }
      
      // Registration flow - Step 4: Get ID type
      case 4: {
        const idTypeMap = {
          '1': 'Ghana Card',
          '2': 'Passport',
          '3': "Driver's License"
        };
        
        const idType = idTypeMap[USERDATA];
        if (!idType) {
          responseMsg = "❌ Invalid selection. Select ID type:\n1. Ghana Card\n2. Passport\n3. Driver's License";
          break;
        }
        
        responseMsg = `Enter your ${idType} number:`;
        await supabase
          .from("ussd_sessions")
          .update({ step: 5, data: { ...session.data, idType } })
          .eq("id", session.id);
        break;
      }
      
      // Registration flow - Step 5: Validate ID number and complete registration
      case 5: {
        const idNumber = USERDATA.trim().toUpperCase();
        const idType = session.data.idType;
        let isValid = false;
        let errorMessage = "";

        // Validate based on ID type
        if (idType === 'Ghana Card') {
          // Ghana Card format: GHA followed by 10 digits (example: GHA1234567890)
          const ghanaCardRegex = /^GHA\d{10}$/;
          isValid = ghanaCardRegex.test(idNumber);
          errorMessage = "❌ Invalid Ghana Card format. Example: GHA1234567890";
        } else if (idType === 'Passport') {
          // Passport format: A1234567 or G1234567
          const passportRegex = /^[AG]\d{7}$/;
          isValid = passportRegex.test(idNumber);
          errorMessage = "❌ Invalid Passport format. Must start with A or G followed by 7 digits. Example: A1234567 or G1234567";
        } else if (idType === "Driver's License") {
          // Driver's License format: MIC-DDMMYYYY-XXXX (example: MIC-05081980-7558)
          const driversLicenseRegex = /^MIC-\d{8}-\d{4}$/;
          isValid = driversLicenseRegex.test(idNumber);
          errorMessage = "❌ Invalid Driver's License format. Example: MIC-05081980-7558";
        }

        if (!isValid) {
          responseMsg = `${errorMessage}\n\nPlease enter your ${idType} number:`;
          break;
        }
        
        try {
          // Save user with ID type information
          const { error } = await supabase.from("users").upsert({
            msisdn: MSISDN,
            name: session.data.name,
            dob: session.data.dob,
            idtype: idType,  // Changed from id_type to idtype
            idnumber: idNumber,  // Changed from id_number to idnumber
            registration_date: new Date().toISOString()
          });
          
          if (error) throw error;
          
          responseMsg = `✅ Registration successful!\nThank you, ${session.data.name || 'valued customer'}.\n\nYou can now apply for a loan.`;
          continueSession = false;
          
          // Clean up session
          await supabase.from("ussd_sessions").delete().eq("id", session.id);
          
        } catch (error) {
          console.error("Registration error:", error);
          if (error.code === '23505') { // Unique violation
            responseMsg = "❌ This ID number is already registered. Please contact support if this is an error.";
          } else {
            responseMsg = "❌ An error occurred during registration. Please try again.";
          }
          continueSession = false;
        }
        break;
      }

      // Loan application flow
      case 10: {
        // Clean and validate input
        const cleanAmount = USERDATA.trim().replace(/[^0-9.]/g, '');
        const principal = Number.parseFloat(cleanAmount);
        
        // Validate loan amount
        if (Number.isNaN(principal) || principal <= 0) {
          responseMsg = "❌ Invalid amount. Please enter a valid number:";
          break;
        } else if (principal < MIN_LOAN_AMOUNT) {
          responseMsg = `❌ Minimum loan amount is GHS ${MIN_LOAN_AMOUNT}. Please enter a higher amount:`;
          break;
        } else if (principal > MAX_LOAN_AMOUNT) {
          responseMsg = `❌ Maximum loan amount is GHS ${MAX_LOAN_AMOUNT}. Please enter a lower amount:`;
          break;
        }
        
        try {
            // Calculate loan details
            const interest = principal * INTEREST_RATE;
            const totalDue = principal + interest;
            const dueDate = addDays(new Date(), LOAN_TERM_DAYS);
            const formattedDueDate = new Date(dueDate).toLocaleDateString('en-GB');

            // Create loan record
            const { data: loan, error: loanError } = await supabase
              .from("loans")
              .insert([
                {
                  user_id: session.data.userId,
                  principal,
                  interest_rate: INTEREST_RATE,
                  interest_amount: interest,
                  total_due: totalDue,
                  balance: totalDue,
                  due_date: dueDate,
                  status: "pending", // Start with pending status
                },
              ])
              .select()
              .single();

            if (loanError) throw loanError;

            // Update user's last loan application date
            await supabase
              .from("users")
              .update({ last_loan_application: new Date().toISOString() })
              .eq("id", session.data.userId);

            // Send success message
            responseMsg = `✅ Loan application received!\n\n` +
              `Amount: GHS ${money(principal)}\n` +
              `Interest (${(INTEREST_RATE * 100).toFixed(0)}%): GHS ${money(interest)}\n` +
              `Total to repay: GHS ${money(totalDue)}\n` +
              `Due date: ${formattedDueDate}\n\n` +
              `Your application is being processed. You'll receive an SMS confirmation shortly.`;
            
            // End session after successful application
            continueSession = false;
            
            // Clean up session
            await supabase.from("ussd_sessions").delete().eq("id", session.id);
            
            // In a real app, you would trigger an SMS notification here
            // await sendSMS(MSISDN, `Your loan application for GHS ${money(principal)} has been received and is being processed.`);
            
          } catch (error) {
            console.error("Loan application error:", error);
            responseMsg = "❌ An error occurred while processing your application. Please try again later.";
            continueSession = false;
            // Clean up session on error
            await supabase.from("ussd_sessions").delete().eq("id", session.id);
          }
          break;
      }

      // Repayment (records payments + reduces balance; closes when 0)
      case 20: {
        const pay = Number.parseFloat(USERDATA);
        if (Number.isNaN(pay) || pay <= 0) {
          responseMsg = "Invalid amount. Enter amount to repay:";
        } else {
          const loanId = session.data.loanId;

          // Fetch fresh loan
          const { data: loan, error: getErr } = await supabase
            .from("loans")
            .select("*")
            .eq("id", loanId)
            .single();
          if (getErr) throw getErr;

          if (!loan || loan.status !== "active") {
            responseMsg = "No active loan found.";
            continueSession = false;
          } else {
            // Clamp overpayment to remaining balance for math
            const payment = Math.min(pay, Number(loan.balance));
            const newBalance = +(Number(loan.balance) - payment).toFixed(2);

            // Record the payment
            const { error: pErr } = await supabase
              .from("payments")
              .insert([{ loan_id: loan.id, amount: payment.toFixed(2), balance_after: newBalance.toFixed(2) }]);
            if (pErr) throw pErr;

            if (newBalance <= 0) {
              const { error: uErr } = await supabase
                .from("loans")
                .update({ balance: 0, status: "closed" })
                .eq("id", loan.id);
              if (uErr) throw uErr;

              // If user tried to pay more than needed, acknowledge full settlement
              if (pay > payment) {
                responseMsg =
                  `Payment received: GHS ${money(payment)}\n` +
                  `Overpayment ignored: GHS ${money(pay - payment)}\n` +
                  `Loan fully repaid. Thank you!`;
              } else {
                responseMsg = `Payment received: GHS ${money(payment)}\nLoan fully repaid. Thank you!`;
              }
              continueSession = false;
            } else {
              const { error: uErr } = await supabase
                .from("loans")
                .update({ balance: newBalance.toFixed(2) })
                .eq("id", loan.id);
              if (uErr) throw uErr;

              responseMsg =
                `Payment received: GHS ${money(payment)}\n` +
                `Outstanding balance: GHS ${money(newBalance)}`;
              continueSession = false;
            }
          }
        }
        break;
      }

      default: {
        // reset to main on unknown step
        responseMsg =
          "Welcome to sika loan\n1. Register\n2. Apply for Loan\n3. Repay Loan\n4. Check Balance\n5. About\n6. Exit";
        await supabase.from("ussd_sessions").update({ step: 1, data: {} }).eq("id", session.id);
        break;
      }
    }

    // End session when flow completes
    if (!continueSession) {
      await supabase.from("ussd_sessions").delete().eq("id", session.id);
    }

    res.json({
      USERID: `USER-${MSISDN}`,
      MSISDN,
      MSG: responseMsg,
      MSGTYPE: continueSession, // true => continue session, false => end
    });

  } catch (error) {
    console.error("Error handling USSD:", error?.message || error);
    res.status(500).json({
      MSG: "An error occurred. Please try again later.",
      MSGTYPE: false,
    });
  }
});

// ── Start server ────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ USSD app running on port ${PORT}`));
