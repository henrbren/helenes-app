import app from './app.js';

const PORT = Number(process.env.PORT || 8787);
app.listen(PORT, () => {
  console.log(`training-log server listening on http://localhost:${PORT}`);
});
