import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { OutageStatus, Role } from "../../../generated/prisma/enums";
import {
	NOTE_REQUIRED_STATUSES,
	OPEN_OUTAGE_STATUSES,
	OUTAGE_TARGET_STATUSES,
	OUTAGE_TRANSITIONS,
	TRANSITION_ROLE,
} from "./outage.constant";
import { canTransition, computeOutagePriority } from "./outage.utils";

const ALL_STATUSES = Object.values(OutageStatus);

describe("outage state machine", () => {
	// Requirements §6.3, written out once more as the expected truth.
	const ALLOWED: Record<OutageStatus, OutageStatus[]> = {
		REPORTED: ["ASSIGNED", "CANCELLED"],
		ASSIGNED: ["IN_PROGRESS", "ASSIGNED", "CANCELLED"],
		IN_PROGRESS: ["RESOLVED", "ASSIGNED"],
		RESOLVED: [],
		CANCELLED: [],
	};

	it("allows exactly the transitions in the requirements, and no others", () => {
		for (const from of ALL_STATUSES) {
			for (const to of ALL_STATUSES) {
				assert.equal(
					canTransition(from, to),
					ALLOWED[from].includes(to),
					`${from} → ${to}`,
				);
			}
		}
	});

	it("treats RESOLVED and CANCELLED as final", () => {
		for (const to of ALL_STATUSES) {
			assert.equal(canTransition("RESOLVED", to), false);
			assert.equal(canTransition("CANCELLED", to), false);
		}
	});

	it("never moves an outage back to REPORTED", () => {
		for (const from of ALL_STATUSES) {
			assert.equal(canTransition(from, "REPORTED"), false);
		}
	});

	it("lets an assigned or in-progress outage be reassigned", () => {
		assert.equal(canTransition("ASSIGNED", "ASSIGNED"), true);
		assert.equal(canTransition("IN_PROGRESS", "ASSIGNED"), true);
	});

	it("does not let work that has started be cancelled or skipped", () => {
		assert.equal(canTransition("IN_PROGRESS", "CANCELLED"), false);
		assert.equal(canTransition("REPORTED", "IN_PROGRESS"), false);
		assert.equal(canTransition("REPORTED", "RESOLVED"), false);
		assert.equal(canTransition("ASSIGNED", "RESOLVED"), false);
	});

	it("can reach every non-initial status from somewhere", () => {
		for (const to of OUTAGE_TARGET_STATUSES) {
			assert.ok(
				ALL_STATUSES.some((from) => OUTAGE_TRANSITIONS[from].includes(to)),
				`${to} is unreachable`,
			);
		}
	});

	it("keeps every open status able to move on", () => {
		for (const status of OPEN_OUTAGE_STATUSES) {
			assert.ok(OUTAGE_TRANSITIONS[status].length > 0);
		}
	});
});

describe("who may make a transition", () => {
	it("gives dispatching and cancelling to the admin", () => {
		assert.equal(TRANSITION_ROLE.ASSIGNED, Role.ADMIN);
		assert.equal(TRANSITION_ROLE.CANCELLED, Role.ADMIN);
	});

	it("gives the field work to the technician", () => {
		assert.equal(TRANSITION_ROLE.IN_PROGRESS, Role.TECHNICIAN);
		assert.equal(TRANSITION_ROLE.RESOLVED, Role.TECHNICIAN);
	});

	it("names a role for every status an outage can be moved to", () => {
		assert.deepEqual(
			Object.keys(TRANSITION_ROLE).sort(),
			[...OUTAGE_TARGET_STATUSES].sort(),
		);
	});

	it("never lets a customer move an outage", () => {
		assert.ok(!Object.values(TRANSITION_ROLE).includes(Role.CUSTOMER as never));
	});

	it("requires a note exactly when an outage is closed", () => {
		assert.deepEqual([...NOTE_REQUIRED_STATUSES].sort(), [
			"CANCELLED",
			"RESOLVED",
		]);
	});
});

describe("computeOutagePriority", () => {
	it("starts from the feeder's priority", () => {
		assert.equal(computeOutagePriority("CRITICAL", 1), "URGENT");
		assert.equal(computeOutagePriority("HIGH", 1), "HIGH");
		assert.equal(computeOutagePriority("NORMAL", 1), "MEDIUM");
		assert.equal(computeOutagePriority("LOW", 1), "LOW");
	});

	it("does not escalate below 10 reports", () => {
		assert.equal(computeOutagePriority("NORMAL", 0), "MEDIUM");
		assert.equal(computeOutagePriority("NORMAL", 9), "MEDIUM");
	});

	it("moves up one level at 10 reports", () => {
		assert.equal(computeOutagePriority("LOW", 10), "MEDIUM");
		assert.equal(computeOutagePriority("NORMAL", 10), "HIGH");
		assert.equal(computeOutagePriority("HIGH", 10), "URGENT");
	});

	it("moves up only once, however many reports arrive", () => {
		assert.equal(computeOutagePriority("LOW", 500), "MEDIUM");
	});

	it("never goes above URGENT", () => {
		assert.equal(computeOutagePriority("CRITICAL", 10), "URGENT");
		assert.equal(computeOutagePriority("CRITICAL", 500), "URGENT");
	});
});
