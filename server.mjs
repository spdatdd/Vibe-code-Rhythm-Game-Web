import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAppServer } from './server/http.mjs';

const publicRoot = path.resolve(fileURLToPath(new URL('./public/', import.meta.url)));
const port = process.env.PORT || '5173';
const hosted = process.env.ORBIT_HOSTED === '1';
const backendSecret = Buffer.from(process.env.ORBIT_BACKEND_SECRET || '');
if (hosted && backendSecret.length < 32) {
  throw new Error('ORBIT_BACKEND_SECRET cần có ít nhất 32 ký tự.');
}

const server = createAppServer({ publicRoot, port, hosted, backendSecret });
const bindAddress = hosted ? '0.0.0.0' : '127.0.0.1';
server.listen(Number(port), bindAddress, () => console.log(`Orbit Rhythm: http://${bindAddress}:${port}`));
server.on('error', error => {
  console.error(error.code === 'EADDRINUSE' ? 'Game đang chạy ở cổng này. Tắt cửa sổ server cũ trước khi chạy lại.' : error.message);
  process.exitCode = 1;
});
