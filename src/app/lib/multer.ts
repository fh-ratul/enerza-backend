import httpStatus from "http-status";
import multer from "multer";
import { AppError } from "../utils/AppError";

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

const ALLOWED_IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"];

// Files are kept in memory and sent to Cloudinary by the service, after the
// rest of the request has been validated: nothing is stored for a request
// that is going to be rejected anyway.
export const upload = multer({
	storage: multer.memoryStorage(),
	limits: { fileSize: MAX_IMAGE_BYTES, files: 1 },
	fileFilter: (_req, file, callback) => {
		if (!ALLOWED_IMAGE_TYPES.includes(file.mimetype)) {
			return callback(
				new AppError(
					httpStatus.BAD_REQUEST,
					"Only JPEG, PNG or WebP images can be uploaded",
					[{ path: file.fieldname, message: "Unsupported file type" }],
				),
			);
		}

		callback(null, true);
	},
});
