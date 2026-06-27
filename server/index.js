const { startServer } = require('./server-core');

try {
  startServer({
  baseDir: __dirname,
  port: process.env.PORT || 3000,
  adminPort: process.env.ADMIN_PORT || 3010,
  onError: (error) => {
    if (error && error.code === 'EADDRINUSE') {
      console.error(`Server port ${error.port || process.env.PORT || 3000} is already in use. Close the existing process or set PORT to another value.`);
    } else {
      console.error('Server failed to start:', error);
    }
    process.exitCode = 1;
  }
  });
} catch (error) {
  console.error('Server failed to start:', error && error.message ? error.message : error);
  process.exitCode = 1;
}
