import cookieParser from "cookie-parser";
import cors from "cors";
import express, {
	type Application,
	type Request,
	type Response,
} from "express";
import helmet from "helmet";
import httpStatus from "http-status";
import config from "./app/config";
import { globalErrorHandler } from "./app/middleware/globalErrorHandler";
import { notFound } from "./app/middleware/notFound";
import { globalLimiter } from "./app/middleware/rateLimiter";
import { AuthRoutes } from "./app/module/auth/auth.route";
import { sendResponse } from "./app/utils/sendResponse";

const app: Application = express();

// Vercel sits behind one proxy hop: needed for the real client IP (rate limits, audit logs).
app.set("trust proxy", 1);

app.use(helmet());

app.use(
	cors({
		origin: config.frontend_url,
		credentials: true,
	}),
);

app.use(express.json({ limit: "1mb" }));
app.use(cookieParser());

app.use(globalLimiter);

app.use("/api/v1/auth", AuthRoutes);

app.get("/", (_req: Request, res: Response) => {
	sendResponse(res, {
		statusCode: httpStatus.OK,
		success: true,
		message: "Welcome to Enerza — Load Shedding & Power Outage Management API",
		data: null,
	});
});

app.use(notFound);
app.use(globalErrorHandler);

export default app;
