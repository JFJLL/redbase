const { installTimestampedConsole } = require("./src/server/utils");
const { start } = require("./src/server");

installTimestampedConsole();

start().catch((error) => {
  console.error("Failed to start RedBase server", error);
  process.exit(1);
});
