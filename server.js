// server.js
import express from "express";
import { createClient } from "@supabase/supabase-js";
import { v4 as uuidv4 } from "uuid";

const app = express();
app.use(express.json());

// Supabase setup
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

app.post("/ussd", async (req, res) => {
  try {
    const { MSISDN, USERDATA } = req.body;

    // Fetch or create session
    let { data: sessions } = await supabase
      .from("ussd_sessions")
      .select("*")
      .eq("msisdn", MSISDN)
      .limit(1);

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

    switch (session.step) {
      case 0:
        responseMsg = "Welcome to Quick Loans\n1. Register\n2. About\n3. Exit";
        await supabase.from("ussd_sessions").update({ step: 1 }).eq("id", session.id);
        break;

      case 1:
        if (USERDATA === "1") {
          responseMsg = "Enter your full name:";
          await supabase.from("ussd_sessions").update({ step: 2 }).eq("id", session.id);
        } else if (USERDATA === "2") {
          responseMsg = "This is a loan application system.";
          continueSession = false;
        } else if (USERDATA === "3") {
          responseMsg = "Thank you for using Quick Loans. Goodbye!";
          continueSession = false;
        } else {
          responseMsg = "Invalid choice. Try again.\n1. Register\n2. About\n3. Exit";
        }
        break;

      case 2:
        responseMsg = "Enter your date of birth (DD/MM/YYYY):";
        await supabase.from("ussd_sessions").update({ step: 3, data: { name: USERDATA } }).eq("id", session.id);
        break;

      case 3:
        responseMsg = "Enter your National ID number:";
        await supabase.from("ussd_sessions").update({
          step: 4,
          data: { ...session.data, dob: USERDATA }
        }).eq("id", session.id);
        break;

      case 4:
        responseMsg = `Registration successful! Thank you, ${session.data?.name || "user"}.`;
        continueSession = false;
        break;
    }

    // End session if flow completed
    if (!continueSession) {
      await supabase.from("ussd_sessions").delete().eq("id", session.id);
    }

    res.json({
      USERID: `USER-${MSISDN}`,
      SESSIONID: session.id,
      MSISDN,
      MSG: responseMsg,
      MSGTYPE: continueSession, // true = continue, false = end
    });

  } catch (error) {
    console.error("Error handling USSD:", error);
    res.status(500).json({
      MSG: "An error occurred. Please try again later.",
      MSGTYPE: false,
    });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`USSD app running on port ${PORT}`));
