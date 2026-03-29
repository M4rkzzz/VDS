const { startServer } = require('./server-core');

startServer({
  baseDir: __dirname,
  port: process.env.PORT || 3000
});
