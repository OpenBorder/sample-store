import 'dotenv/config';
import path from 'node:path';
import express from 'express';
import { createConfiguredApp } from './app';

const PORT = Number(process.env.PORT ?? 4000);
const HOST = '127.0.0.1';
const app = createConfiguredApp(process.env, { runtime: 'local-tutorial' });

app.use(express.static(path.join(__dirname, 'public')));

app.listen(PORT, HOST, () => {
  console.log(`Sample store on http://${HOST}:${PORT}`);
});
