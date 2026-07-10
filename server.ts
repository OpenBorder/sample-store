import 'dotenv/config';
import path from 'node:path';
import express from 'express';
import app from './app';

const PORT = Number(process.env.PORT ?? 4000);

app.use(express.static(path.join(__dirname, 'public')));

app.listen(PORT, () => {
  console.log(`Sample store on http://localhost:${PORT}`);
});
