import {createBullBoard} from "@bull-board/api";
import {ExpressAdapter} from "@bull-board/express";
import {BullMQAdapter} from "@bull-board/api/bullMQAdapter";
import {BullAdapter} from "@bull-board/api/bullAdapter";
import * as bullmq from "bullmq";
import * as bull from "bullmq";
import { backOff } from "exponential-backoff";

import {client, redisConfig} from "./redis";
import {config} from "./config";

const serverAdapter = new ExpressAdapter();
const {setQueues, addQueue, removeQueue} = createBullBoard({
	queues: [],
	serverAdapter,
	options: {
		uiConfig: {
			miscLinks: [{text: 'refresh', url: '/refresh'}]
		}
	}
});
export const router = serverAdapter.getRouter();

async function getBullQueues() {
	let cursor = '0';
	const keys = [];
	do {
		const res = await client.scan(cursor, 'MATCH', `${config.BULL_PREFIX}:*:id`);
		cursor = res[0];
		keys.push(...res[1]);
	} while (cursor !== '0');
	const uniqKeys = new Set(keys.map(key => key.replace(
	new RegExp(`^${config.BULL_PREFIX}:(.+):[^:]+$`),
		'$1'
	)));
	const queueList = Array.from(uniqKeys).sort().map(
		(item) => config.BULL_VERSION === 'BULLMQ' ?
			new BullMQAdapter(new bullmq.Queue(item, {
				connection: redisConfig.redis,
			}, client.connection)) :
			new BullAdapter(new bull.Queue(item, {
				connection: redisConfig.redis,
			}, client.connection))
	);
	if (queueList.length === 0) {
		throw new Error("No queue found.");
	}
	return queueList;
}

let isRefreshing = false;
let queueList;
async function bullMain() {
	if (isRefreshing) {
		return;
	} else {
		isRefreshing = true;
	}
	try {
		const queueList = await backOff(() => getBullQueues(), {
			delayFirstAttempt: false,
			jitter: "none",
			startingDelay: config.BACKOFF_STARTING_DELAY,
			maxDelay: config.BACKOFF_MAX_DELAY,
			timeMultiple: config.BACKOFF_TIME_MULTIPLE,
			numOfAttempts: config.BACKOFF_NB_ATTEMPTS,
			retry: (e, attemptNumber) => {
				console.log(`No queue! Retry n°${attemptNumber}`);
				return true;
			},
		});
		setQueues(queueList);
		console.log('🚀 done!')
	} catch (err) {
		console.error(err);
	}
	isRefreshing = false;
}

bullMain();

async function refresh() {
	if (isRefreshing) {
		return;
	} else {
		isRefreshing = true;
	}
	try {
		let cursor = '0';
		const keys = [];
		do {
			const res = await client.scan(cursor, 'MATCH', `${config.BULL_PREFIX}:*:id`);
			cursor = res[0];
			keys.push(...res[1]);
		} while (cursor !== '0');
		const uniqKeys = new Set(keys.map(key => key.replace(
			new RegExp(`^${config.BULL_PREFIX}:(.+):[^:]+$`),
			'$1'
		)));
		const currentKeys = queueList.map(queue => queue.getName());
		const addKeys = Array.from(uniqKeys).filter(key => !currentKeys.includes(key));
		const removeKeys = currentKeys.filter(key => !Array.from(uniqKeys).includes(key));
		for (const key of addKeys) {
			const queue = config.BULL_VERSION === 'BULLMQ' ?
				new BullMQAdapter(new bullmq.Queue(key, {
					connection: redisConfig.redis,
				}, client.connection)) :
				new BullAdapter(new bull.Queue(key, {
					connection: redisConfig.redis,
				}, client.connection));
			addQueue(queue);
			queueList.push(queue);
		}
		for (const key of removeKeys) {
			const queue = queueList.find(queue => queue.getName() === key);
			removeQueue(queue);
			queueList = queueList.filter(queue => queue.getName() !== key);
		}
		console.log('🚀 done!')
	} catch (err) {
		console.error(err);
	}
	isRefreshing = false;
}

export const refreshRouter = async (req, res) => {
	await refresh();
	res.redirect('/');
};
