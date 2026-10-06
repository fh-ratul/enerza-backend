import { createClient } from "redis";
import config from "../config";

const CONNECT_TIMEOUT_MS = 5000;
const MAX_RECONNECT_ATTEMPTS = 3;
// After a failed connect, skip Redis for a while instead of making every
// request sit through another connection timeout.
const RETRY_COOLDOWN_MS = 30_000;

export const redisClient = createClient({
	username: config.redis_user,
	password: config.redis_password,
	socket: {
		host: config.redis_host,
		port: config.redis_port,
		connectTimeout: CONNECT_TIMEOUT_MS,
		reconnectStrategy: (retries) =>
			retries >= MAX_RECONNECT_ATTEMPTS ? false : Math.min(retries * 200, 1000),
	},
	// Redis is best-effort here: while disconnected, commands must fail
	// immediately (and fall back to the DB) rather than queue up forever.
	disableOfflineQueue: true,
});

let lastLoggedError = "";

// The client emits one error per failed attempt, so log each distinct problem once.
redisClient.on("error", (error: Error & { code?: string }) => {
	const reason = error.message || error.code || error.name;

	if (reason !== lastLoggedError) {
		lastLoggedError = reason;
		console.warn(`Redis unavailable: ${reason}`);
	}
});

redisClient.on("ready", () => {
	lastLoggedError = "";
});

let connecting: Promise<unknown> | null = null;
let lastFailureAt = 0;

// Returns a ready client or throws. Connects lazily, which is what serverless
// needs: there is no long-lived boot phase to connect in.
export const getRedis = async () => {
	if (redisClient.isReady) {
		return redisClient;
	}

	if (Date.now() - lastFailureAt < RETRY_COOLDOWN_MS) {
		throw new Error("Redis is unavailable");
	}

	if (!redisClient.isOpen) {
		connecting ??= redisClient.connect().finally(() => {
			connecting = null;
		});
	}

	if (!connecting) {
		// Open but not ready: the client is reconnecting in the background.
		throw new Error("Redis is reconnecting");
	}

	try {
		await connecting;
	} catch (error) {
		lastFailureAt = Date.now();
		throw error;
	}

	return redisClient;
};
