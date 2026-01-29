const express = require("express");
const app = express();

const PORT = process.env.PORT || 3000;

app.get("/", (req, res) => res.status(200).send("OK"));
app.get("/health", (req, res) => res.status(200).json({ ok: true }));

app.listen(PORT, "0.0.0.0", () => {
  console.log("Listening on", PORT);
});
