import { v2 as Cloudinary } from "cloudinary";
import httpStatus from "http-status";
import config from "../config";
import { AppError } from "../utils/AppError";

Cloudinary.config({
	cloud_name: config.cloudinary_cloud_name,
	api_key: config.cloudinary_api_key,
	api_secret: config.cloudinary_api_secret,
	secure: true,
});

export const cloudinary = Cloudinary;

export type TUploadedImage = {
	url: string;
	publicId: string;
};

// Uploads an in-memory image. This is a network call, so it runs before (or
// after) a database transaction, never inside one.
export const uploadImage = (
	buffer: Buffer,
	folder: "profiles" | "outage-reports",
): Promise<TUploadedImage> =>
	new Promise((resolve, reject) => {
		const fail = () =>
			reject(
				new AppError(
					httpStatus.BAD_GATEWAY,
					"The image could not be uploaded. Please try again",
				),
			);

		cloudinary.uploader
			.upload_stream(
				{ folder: `enerza/${folder}`, resource_type: "image" },
				(error, result) => {
					if (error || !result) {
						return fail();
					}

					resolve({ url: result.secure_url, publicId: result.public_id });
				},
			)
			.on("error", fail)
			.end(buffer);
	});

// Best-effort: an image that could not be removed only costs storage.
export const deleteImage = async (publicId: string): Promise<void> => {
	try {
		await cloudinary.uploader.destroy(publicId);
	} catch {
		// ignored on purpose
	}
};
