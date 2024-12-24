import { api } from 'encore.dev/api';
import { CronJob } from 'encore.dev/cron';
import { SQLDatabase } from 'encore.dev/storage/sqldb';
import { site } from '~encore/clients';
import { Site } from '../site/site';
import { ping } from './ping';
import { Topic } from 'encore.dev/pubsub';

// Check checks a single site.
export const check = api(
	{ expose: true, method: 'POST', path: '/check/:siteID' },
	async (p: { siteID: number }): Promise<{ up: boolean }> => {
		const s = await site.get({ id: p.siteID });
		return doCheck(s);
	}
);

// CheckAll checks all sites.
export const checkAll = api(
	{ expose: true, method: 'POST', path: '/check-all' },
	async (): Promise<void> => {
		const sites = await site.list();
		await Promise.all(sites.sites.map(doCheck));
	}
);

// Define a database named 'monitor', using the database migrations
// in the "./migrations" folder. Encore automatically provisions,
// migrates, and connects to the database.
export const MonitorDB = new SQLDatabase('monitor', {
	migrations: './migrations',
});

// Check all tracked sites every 1 hour.
const cronJob = new CronJob('check-all', {
	title: 'Check all sites',
	every: '1h',
	endpoint: checkAll,
});

// TransitionEvent describes a transition of a monitored site
// from up->down or from down->up.
export interface TransitionEvent {
	site: Site; // Site is the monitored site in question.
	up: boolean; // Up specifies whether the site is now up or down (the new value).
}

// TransitionTopic is a pubsub topic with transition events for when a monitored site
// transitions from up->down or from down->up.
export const TransitionTopic = new Topic<TransitionEvent>('uptime-transition', {
	deliveryGuarantee: 'at-least-once',
});

// getPreviousMeasurement reports whether the given site was
// up or down in the previous measurement.
async function getPreviousMeasurement(siteID: number): Promise<boolean> {
	const row = await MonitorDB.queryRow`
		SELECT up
		FROM checks
		WHERE site_id = ${siteID}
		ORDER BY checked_at DESC
		LIMIT 1
	`;
	return row?.up ?? true;
}
const test = await TransitionTopic.publish({
	site: {
		id: 1,
		url: 'google.com',
	},
	up: true,
});
console.log('🚀 ~ test:', test);

async function doCheck(site: Site): Promise<{ up: boolean }> {
	const { up } = await ping({ url: site.url });

	// Publish a Pub/Sub message if the site transitions
	// from up->down or from down->up.
	const wasUp = await getPreviousMeasurement(site.id);
	if (up !== wasUp) {
		await TransitionTopic.publish({ site, up });
	}

	await MonitorDB.exec`
		INSERT INTO checks (site_id, up, checked_at)
		VALUES (${site.id}, ${up}, NOW())
	`;
	return { up };
}
