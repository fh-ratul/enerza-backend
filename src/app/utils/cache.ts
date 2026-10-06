import crypto from "node:crypto";
import { getRedis } from "../lib/redis";

// Caching is best-effort: every helper swallows Redis failures, so a cache
// outage only costs speed. Reads then fall through to the database.

export const CACHE_KEYS = {
	// Bumped on every feeder write; it is part of each list key, so one INCR
	// invalidates all cached feeder pages at once.
	feedersVersion: "feeders:v",
	feedersList: (version: string, queryHash: string) =>
		`feeders:list:v${version}:${queryHash}`,
	customerSchedules: (feederId: string) => `schedules:customer:${feederId}`,
	adminStats: "admin:stats",
} as const;

export const CACHE_TTL = {
	feedersList: 120,
	customerSchedules: 60,
	adminStats: 300,
} as const;

export const cacheGet = async <T>(key: string): Promise<T | null> => {
	try {
		const client = await getRedis();
		const value = await client.get(key);

		return value ? (JSON.parse(value) as T) : null;
	} catch {
		return null;
	}
};

export const cacheSet = async (
	key: string,
	value: unknown,
	ttlSeconds: number,
): Promise<void> => {
	try {
		const client = await getRedis();

		await client.set(key, JSON.stringify(value), {
			expiration: {
				type: "EX",
				value: ttlSeconds,
			},
		});
	} catch {
		// best-effort
	}
};

export const cacheDel = async (...keys: string[]): Promise<void> => {
	if (keys.length === 0) {
		return;
	}

	try {
		const client = await getRedis();

		await client.del(keys);
	} catch {
		// best-effort
	}
};

// Returns null when Redis is unreachable, which callers treat as "do not cache".
export const cacheGetVersion = async (key: string): Promise<string | null> => {
	try {
		const client = await getRedis();

		return (await client.get(key)) ?? "0";
	} catch {
		return null;
	}
};

export const cacheBumpVersion = async (key: string): Promise<void> => {
	try {
		const client = await getRedis();

		await client.incr(key);
	} catch {
		// best-effort
	}
};

// Stable hash of a query object: the same filters in any order share a key.
export const hashQuery = (query: Record<string, unknown>): string => {
	const sorted = Object.keys(query)
		.sort()
		.map((key) => [key, query[key]]);

	return crypto
		.createHash("sha1")
		.update(JSON.stringify(sorted))
		.digest("hex")
		.slice(0, 16);
};
