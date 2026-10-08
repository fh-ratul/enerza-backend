import app from "./app";
import config from "./app/config";
import { prisma } from "./app/lib/prisma";
import { getRedis } from "./app/lib/redis";

const PORT = config.port;

const main = async () => {
	try {
		await prisma.$connect();
		console.log("Connected to the database successfully.");

		// Redis only backs caching and rate limiting, so a failure here is not fatal.
		try {
			await getRedis();
			console.log("Redis Connected Successfully.");
		} catch {
			console.warn(
				"Starting without Redis: caching is off and rate limits are per-instance.",
			);
		}

		app.listen(PORT, () => {
			console.log(`Server is running on port ${PORT}`);
		});
	} catch (error) {
		console.error("Error starting the server:", error);
		await prisma.$disconnect();
		process.exit(1);
	}
};

// Locally (and on any long-running host) the server connects and listens.
// On Vercel the default export below is the request handler: connections
// are opened lazily by the first query.
if (!config.is_serverless) {
	main();
}

export default app;
