import type { Request, Response } from "express";
import {
	type IncrementResponse,
	ipKeyGenerator,
	MemoryStore,
	type Options,
	rateLimit,
	type Store,
} from "express-rate-limit";
import httpStatus from "http-status";
import { type RedisReply, RedisStore } from "rate-limit-redis";
import { getRedis } from "../lib/redis";

// Counters live in Redis so that every serverless instance shares them.
// If Redis is unreachable the limiter falls back to per-instance memory:
// weaker, but requests are still served and still limited.
class ResilientRedisStore implements Store {
	readonly prefix: string;
	private options?: Options;
	private redisStore?: RedisStore;
	private readonly memoryStore = new MemoryStore();

	constructor(prefix: string) {
		this.prefix = prefix;
	}

	init(options: Options) {
		this.options = options;
		this.memoryStore.init(options);
	}

	private async redis(): Promise<RedisStore> {
		const client = await getRedis();

		if (!this.redisStore) {
			// Created lazily: the store loads its Lua scripts in the constructor,
			// which needs a live connection.
			const store = new RedisStore({
				prefix: this.prefix,
				sendCommand: (...args: string[]) =>
					client.sendCommand(args) as Promise<RedisReply>,
			});

			if (this.options) {
				store.init(this.options);
			}

			this.redisStore = store;
		}

		return this.redisStore;
	}

	async increment(key: string): Promise<IncrementResponse> {
		try {
			return await (await this.redis()).increment(key);
		} catch {
			return this.memoryStore.increment(key);
		}
	}

	async decrement(key: string): Promise<void> {
		try {
			await (await this.redis()).decrement(key);
		} catch {
			await this.memoryStore.decrement(key);
		}
	}

	async resetKey(key: string): Promise<void> {
		try {
			await (await this.redis()).resetKey(key);
		} catch {
			await this.memoryStore.resetKey(key);
		}
	}
}

type TLimiterConfig = {
	name: string;
	windowMs: number;
	limit: number;
	message: string;
	// defaults to the client IP
	keyGenerator?: (req: Request) => string;
};

const createLimiter = ({
	name,
	windowMs,
	limit,
	message,
	keyGenerator,
}: TLimiterConfig) =>
	rateLimit({
		windowMs,
		limit,
		...(keyGenerator && { keyGenerator }),
		standardHeaders: "draft-8",
		legacyHeaders: false,
		store: new ResilientRedisStore(`rl:${name}:`),
		handler: (_req: Request, res: Response) => {
			res.status(httpStatus.TOO_MANY_REQUESTS).json({
				success: false,
				statusCode: httpStatus.TOO_MANY_REQUESTS,
				message,
				errors: [{ path: "", message }],
			});
		},
	});

// Every request.
export const globalLimiter = createLimiter({
	name: "global",
	windowMs: 60 * 1000,
	limit: 100,
	message: "Too many requests. Please slow down and try again shortly",
});

// Register, login and Google login: slows down credential stuffing.
export const authLimiter = createLimiter({
	name: "auth",
	windowMs: 15 * 60 * 1000,
	limit: 10,
	message: "Too many authentication attempts. Please try again in 15 minutes",
});

// Payment initiation: each call creates a bKash payment session. Mounted
// after auth() and counted per user, so customers behind one shared IP do not
// use up each other's attempts.
export const paymentLimiter = createLimiter({
	keyGenerator: (req) => req.user?.userId ?? ipKeyGenerator(req.ip ?? ""),
	name: "payment",
	windowMs: 60 * 1000,
	limit: 5,
	message: "Too many payment attempts. Please try again in a minute",
});
