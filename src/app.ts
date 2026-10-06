import cookieParser from "cookie-parser";
import cors from "cors";
import express, {
	type Application,
	type Request,
	type Response,
} from "express";
import httpStatus from "http-status";
import config from "./app/config";
import { globalErrorHandler } from "./app/middleware/globalErrorHandler";
import { notFound } from "./app/middleware/notFound";
import { sendResponse } from "./app/utils/sendResponse";

const app: Application = express();

app.use(
	cors({
		origin: config.frontend_url,
		credentials: true,
	}),
);

app.use(express.json({ limit: "1mb" }));
app.use(cookieParser());

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
