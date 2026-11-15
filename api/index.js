const { openDb } = require("../lib/db");
const { createHandler } = require("../lib/handler");

let handlerPromise;

module.exports = async function vercelHandler(req, res) {
  try {
    handlerPromise ||= openDb()
      .then(createHandler)
      .catch((error) => {
        handlerPromise = undefined;
        throw error;
      });
    const handleRequest = await handlerPromise;
    if (!(await handleRequest(req, res))) {
      res.statusCode = 404;
      res.end("Not found");
    }
  } catch (error) {
    console.error(error);
    res.statusCode = 500;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: error.message }));
  }
};
