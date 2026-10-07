// Pure dashboard maths: no database access, so it can be unit-tested directly.

type TZoneInput = {
	id: string;
	name: string;
	code: string;
	feederIds: string[];
};

type TResolvedOutage = {
	feederId: string;
	durationMinutes: number | null;
};

const round = (value: number, decimals: number): number =>
	Number(value.toFixed(decimals));

// The standard reliability indices, counted over resolved outages:
//   SAIFI = Σ customers interrupted ÷ customers served
//           (how many interruptions the average customer had)
//   SAIDI = Σ (customers interrupted × minutes) ÷ customers served
//           (how many minutes the average customer was without power)
// An outage interrupts every customer on its feeder.
const toIndices = (
	customers: number,
	outages: TResolvedOutage[],
	customersByFeeder: Map<string, number>,
) => {
	let customerInterruptions = 0;
	let customerMinutes = 0;

	for (const outage of outages) {
		const affected = customersByFeeder.get(outage.feederId) ?? 0;

		customerInterruptions += affected;
		customerMinutes += affected * (outage.durationMinutes ?? 0);
	}

	return {
		customers,
		outages: outages.length,
		saifi: customers > 0 ? round(customerInterruptions / customers, 3) : 0,
		saidiMinutes: customers > 0 ? round(customerMinutes / customers, 1) : 0,
	};
};

export const computeReliability = (
	zones: TZoneInput[],
	customersByFeeder: Map<string, number>,
	resolvedOutages: TResolvedOutage[],
) => {
	const countCustomers = (feederIds: string[]) =>
		feederIds.reduce(
			(total, feederId) => total + (customersByFeeder.get(feederId) ?? 0),
			0,
		);

	const byZone = zones.map(({ feederIds, ...zone }) => {
		const zoneFeeders = new Set(feederIds);

		return {
			zone,
			...toIndices(
				countCustomers(feederIds),
				resolvedOutages.filter((outage) => zoneFeeders.has(outage.feederId)),
				customersByFeeder,
			),
		};
	});

	const allFeederIds = zones.flatMap((zone) => zone.feederIds);
	const servedFeeders = new Set(allFeederIds);

	return {
		overall: toIndices(
			countCustomers(allFeederIds),
			resolvedOutages.filter((outage) => servedFeeders.has(outage.feederId)),
			customersByFeeder,
		),
		byZone,
	};
};

// groupBy rows → { KEY: count } with every key present, zero included.
export const toCountMap = <K extends string>(
	keys: readonly K[],
	rows: { key: K; count: number }[],
): Record<K, number> => {
	const counts = Object.fromEntries(keys.map((key) => [key, 0])) as Record<
		K,
		number
	>;

	for (const row of rows) {
		counts[row.key] += row.count;
	}

	return counts;
};
