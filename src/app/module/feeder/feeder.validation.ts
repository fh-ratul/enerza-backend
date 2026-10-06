import { z } from "zod";
import { FeederPriority } from "../../../generated/prisma/enums";
import {
	paginationQueryShape,
	queryBooleanSchema,
	searchTermSchema,
} from "../../utils/commonValidation";
import {
	FEEDER_SORTABLE_FIELDS,
	MAX_AREAS_PER_REQUEST,
} from "./feeder.constant";

// e.g. "FD-MIR-01", "AR-PALLABI"
const codeSchema = (label: string) =>
	z
		.string(`${label} code is required`)
		.trim()
		.toUpperCase()
		.regex(
			/^[A-Z0-9-]{3,20}$/,
			`${label} code must be 3-20 letters, digits or hyphens`,
		);

const nameSchema = (label: string) =>
	z
		.string(`${label} name is required`)
		.trim()
		.min(2, `${label} name must be at least 2 characters long`)
		.max(80, `${label} name cannot be longer than 80 characters`);

const loadMWSchema = z
	.number("loadMW must be a number")
	.positive("loadMW must be greater than 0")
	.max(1000, "loadMW cannot exceed 1000")
	.refine(
		(value) => Math.abs(value * 100 - Math.round(value * 100)) < 1e-6,
		"loadMW can have at most 2 decimal places",
	);

const prioritySchema = z.enum(
	FeederPriority,
	"priority must be CRITICAL, HIGH, NORMAL or LOW",
);

const areasSchema = z
	.array(
		z
			.object({
				name: nameSchema("Area"),
				code: codeSchema("Area"),
			})
			.strict(),
		"areas must be a list",
	)
	.max(
		MAX_AREAS_PER_REQUEST,
		`At most ${MAX_AREAS_PER_REQUEST} areas can be added per request`,
	)
	.superRefine((areas, ctx) => {
		const seen = new Set<string>();

		areas.forEach((area, index) => {
			if (seen.has(area.code)) {
				ctx.addIssue({
					code: "custom",
					path: [index, "code"],
					message: `Area code ${area.code} is repeated in this request`,
				});
			}

			seen.add(area.code);
		});
	});

const CreateFeederZodSchema = z
	.object({
		name: nameSchema("Feeder"),
		code: codeSchema("Feeder"),
		loadMW: loadMWSchema,
		priority: prioritySchema.default(FeederPriority.NORMAL),
		isActive: z.boolean("isActive must be true or false").default(true),
		substationId: z.uuid("substationId must be a valid id"),
		areas: areasSchema.default([]),
	})
	.strict();

// `code` and `substationId` identify where the feeder sits on the grid and
// cannot be changed. `areas` are appended to the feeder's existing areas.
const UpdateFeederZodSchema = z
	.object({
		name: nameSchema("Feeder").optional(),
		loadMW: loadMWSchema.optional(),
		priority: prioritySchema.optional(),
		isActive: z.boolean("isActive must be true or false").optional(),
		areas: areasSchema.optional(),
	})
	.strict()
	.refine((body) => Object.keys(body).length > 0, {
		message: "Provide at least one field to update",
	});

const FeederListQueryZodSchema = z.object({
	...paginationQueryShape,
	sortBy: z
		.enum(
			FEEDER_SORTABLE_FIELDS,
			`sortBy must be one of: ${FEEDER_SORTABLE_FIELDS.join(", ")}`,
		)
		.optional(),
	searchTerm: searchTermSchema.optional(),
	zoneId: z.uuid("zoneId must be a valid id").optional(),
	substationId: z.uuid("substationId must be a valid id").optional(),
	priority: prioritySchema.optional(),
	isActive: queryBooleanSchema.optional(),
});

export const FeederValidation = {
	CreateFeederZodSchema,
	UpdateFeederZodSchema,
	FeederListQueryZodSchema,
};
