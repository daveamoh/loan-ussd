// server.js
import express from "express";
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";

dotenv.config();

const app = express();
app.use(express.json());

// ── Config ──────────────────────────────────────────────────────────────
const INTEREST_RATE = parseFloat(process.env.INTEREST_RATE || "0.10"); // 10% simple interest
const LOAN_TERM_DAYS = parseInt(process.env.LOAN_TERM_DAYS || "30", 10); // due date helper

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
          "Welcome to Quick Loans\n1. Register\n2. Apply for Loan\n3. Repay Loan\n4. Check Balance\n5. About\n6. Exit";
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
          responseMsg = "Quick Loans: simple microloans with transparent interest.";
          continueSession = false;

        } else if (USERDATA === "6") {
          responseMsg = "Thank you for using Quick Loans. Goodbye!";
          continueSession = false;

        } else {
          responseMsg =
            "Invalid choice. Try again.\n1. Register\n2. Apply for Loan\n3. Repay Loan\n4. Check Balance\n5. About\n6. Exit";
        }
        break;
      }

      // Registration flow
      case 2: {
        responseMsg = "Enter your date of birth (DD/MM/YYYY):";
        await supabase
          .from("ussd_sessions")
          .update({ step: 3, data: { name: USERDATA } })
          .eq("id", session.id);
        break;
      }

      case 3: {
        responseMsg = "Enter your National ID number:";
        await supabase
          .from("ussd_sessions")
          .update({ step: 4, data: { ...session.data, dob: USERDATA } })
          .eq("id", session.id);
        break;
      }

      case 4: {
        // Save user
        await supabase.from("users").upsert({
          msisdn: MSISDN,
          name: session.data.name,
          dob: session.data.dob,
          national_id: USERDATA
        });
        responseMsg = `Registration successful! Thank you, ${session.data?.name || "user"}.`;
        continueSession = false;
        break;
      }

      // Loan application (with interest)
      case 10: {
        const principal = Number.parseFloat(USERDATA);
        if (Number.isNaN(principal) || principal <= 0) {
          responseMsg = "Invalid amount. Enter loan amount (GHS):";
        } else {
          const interestAmount = +(principal * INTEREST_RATE).toFixed(2);
          const totalDue = +(principal + interestAmount).toFixed(2);
          const balance = totalDue;
          const dueDate = addDays(new Date(), LOAN_TERM_DAYS);

          const { data: loan, error: lErr } = await supabase
            .from("loans")
            .insert([{
              user_id: session.data.userId,
              principal: principal.toFixed(2),
              interest_rate: INTEREST_RATE,
              interest_amount: interestAmount.toFixed(2),
              total_due: totalDue.toFixed(2),
              balance: balance.toFixed(2),
              status: "active",
              due_date: dueDate
            }])
            .select()
            .single();
          if (lErr) throw lErr;

          responseMsg =
            `Loan Approved!\n` +
            `Principal: GHS ${money(loan.principal)}\n` +
            `Interest (${(loan.interest_rate * 100).toFixed(2)}%): GHS ${money(loan.interest_amount)}\n` +
            `Total Due: GHS ${money(loan.total_due)}\n` +
            `Due: ${loan.due_date}`;
          continueSession = false;
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
          "Welcome to Quick Loans\n1. Register\n2. Apply for Loan\n3. Repay Loan\n4. Check Balance\n5. About\n6. Exit";
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
      SESSIONID: session.id,
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
