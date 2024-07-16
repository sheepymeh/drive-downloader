const browser = chrome;

browser.webRequest.onBeforeRequest.addListener(async e => {
	if (e.tabId < 0) return;
	const tab = await browser.tabs.get(e.tabId);
	const docID = new URL(tab.url).pathname.split('/')[3];

	const url = new URL(e.url);
	const viewID = url.searchParams.get('id');

	if (!viewID) return;

	const prevID = (await browser.storage.session.get(docID))[docID];
	if (viewID !== prevID) {
		await browser.storage.session.set({ [docID]: viewID });
	}
}, { urls: ['https://drive.google.com/viewerng/*'] });