export default async function handler(req, res) {
  const { code, field, days, key } = req.query;

  const url = `https://script.google.com/macros/s/AKfycbzCnWwico_cqQzr2NnSDExG0VklGfq7oym4idt0l0uXB-eRzhl9FhX87A9lWzFEiCOk/exec?op=series&code=${code}&days=${days}&field=${field}&key=${key}`;

  try {
    const response = await fetch(url);
    const data = await response.json();
    res.status(200).json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
