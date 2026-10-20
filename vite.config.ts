import { defineConfig } from 'vite';
import basicSsl from '@vitejs/plugin-basic-ssl';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const certificate = resolve('certs/localhost.pem');
const privateKey = resolve('certs/localhost-key.pem');
const trustedCertificateAvailable = existsSync(certificate) && existsSync(privateKey);

export default defineConfig({
  plugins: trustedCertificateAvailable ? [] : [basicSsl()],
  server: {
    port: 5173,
    ...(trustedCertificateAvailable ? { https: { cert: readFileSync(certificate), key: readFileSync(privateKey) } } : {}),
    proxy: { '/api': 'http://127.0.0.1:3001' },
  },
});
