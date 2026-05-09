const browser = chrome;
const maxSideLength = 600;

const unsupportedContainer = document.querySelector('#unsupported-container');
const errorContainer = document.querySelector('#error-container');

const downloadButton = document.querySelector('#download-button');
const downloadFname = document.querySelector('#fname');

const statusContainer = document.querySelector('#status-container');
const progressBar = document.querySelector('#progress-bar');
const statusText = document.querySelector('#status-text');

const successContainer = document.querySelector('#success-container');

async function sleep(ms) {
	return new Promise(resolve => setTimeout(resolve, ms));
}

function setStatus(text, value) {
	statusText.innerText = text;
	progressBar.value = value;
}

async function fetchWithRetry(url, options = {}, attempts = 3, delayMs = 250) {
	let lastError;

	for (let i = 0; i < attempts; i++) {
		try {
			const req = await fetch(url, options);
			if (req.ok || ![429, 500, 502, 503, 504].includes(req.status) || i === attempts - 1) {
				return req;
			}
		} catch (error) {
			lastError = error;
			if (i === attempts - 1) throw error;
		}

		await sleep(delayMs * (i + 1));
	}

	throw lastError || new Error('Request failed after retries.');
}

async function getFname(tab) {
	const tabTitle = tab.title?.trim();
	if (tabTitle && !/^(google drive|google docs)$/i.test(tabTitle)) {
		return tabTitle.replace(/ - Google (Drive|Docs)$/, '').trim();
	}

	const [{ result }] = await browser.scripting.executeScript({
		target: { tabId: tab.id },
		func: () => {
			if (location.hostname === 'docs.google.com') {
				const docsTitle = document.querySelector('#docs-title-input-label-inner')?.innerText?.trim();
				const docsMetaTitle = document.querySelector('meta[property="og:title"]')?.content?.trim();
				return docsTitle || docsMetaTitle || document.title.replace(/ - Google Docs$/, '').trim();
			}

			const metaTitle = document.querySelector('meta[property="og:title"]')?.content?.trim();
			const metaName = document.querySelector('meta[name="title"]')?.content?.trim();
			if (metaTitle || metaName) return metaTitle || metaName;

			for (const selector of ['[aria-label$=" icon"]', '[aria-label*=" icon"]', '[role="heading"]']) {
				const element = document.querySelector(selector);
				const text = element?.nextSibling?.textContent?.trim() || element?.innerText?.trim();
				if (text) return text;
			}

			return document.querySelector('h1')?.innerText?.trim() || document.title.replace(/ - Google Drive$/, '').trim() || 'Google Drive file';
		},
	});

	return result;
}

async function refreshViewID(docID) {
	const oldID = (await browser.storage.session.get(docID))[docID];
	const backgroundTab = await browser.tabs.create({
		active: false,
		url: `https://drive.google.com/file/d/${docID}/edit`,
	});
	try {
		let viewID;
		for (let i = 0; i < 40; i++) {
			viewID = (await browser.storage.session.get(docID))[docID];
			if (viewID != oldID) break;
			await sleep(250);
		}

		if (!viewID || viewID === oldID) {
			throw new Error('Failed to refresh viewID for this document.');
		}

		return viewID;
	} finally {
		browser.tabs.remove(backgroundTab.id);
	}
}

async function getJSON(endpoint, params, docID) {
	let req = await fetchWithRetry(`https://drive.google.com/viewerng/${endpoint}?${params.toString()}`);
	if (!req.ok) {
		params.set('id', await refreshViewID(docID));
		req = await fetchWithRetry(`https://drive.google.com/viewerng/${endpoint}?${params.toString()}`);
	}

	const text = await req.text();
	const json = text.split('\n').at(-1);
	return JSON.parse(json);
}

function isWordLeaf(node) {
	return Array.isArray(node)
		&& node.length === 2
		&& Array.isArray(node[0])
		&& node[0].length === 4
		&& node[0].every(value => typeof value === 'number')
		&& typeof node[1] === 'string';
}

function collectWordLeaves(node, leaves = []) {
	if (!Array.isArray(node)) return leaves;

	if (isWordLeaf(node)) {
		leaves.push(node);
		return leaves;
	}

	for (const child of node) {
		collectWordLeaves(child, leaves);
	}

	return leaves;
}

document.addEventListener('DOMContentLoaded', async () => {
	const tabs = await browser.tabs.query({ active: true, currentWindow: true });
	const url = tabs[0].url;
	if (!url.includes('drive.google.com') && !url.includes('docs.google.com')) {
		document.body.className = 'unsupported';
	}
	else {
		downloadFname.innerText = await getFname(tabs[0]);
		document.body.className = 'ready';
	}
});

downloadButton.addEventListener('click', async () => {
	try {
		document.body.className = 'downloading';
		setStatus('Getting document data...', 0);

		const tabs = await browser.tabs.query({ active: true, currentWindow: true });
		const url = new URL(tabs[0].url);
		const docID = url.pathname.split('/')[3];
		const authuser = url.searchParams.get('authuser') || '0';

		let viewID = (await browser.storage.session.get(docID))[docID];
		if (!viewID) viewID = await refreshViewID(docID);

		const pdf = await PDFLib.PDFDocument.create();
		const font = await pdf.embedFont(PDFLib.StandardFonts.Helvetica);

		const metadata = await getJSON('meta', new URLSearchParams({
			id: viewID,
			authuser,
		}), docID);
		progressBar.max = metadata.pages + 1;

		for (let i = 0; i < metadata.pages; i++) {
			setStatus(`Downloading page ${i + 1} of ${metadata.pages}...`, i + 1);

			const params = new URLSearchParams({
				id: viewID,
				authuser,
				page: i,
				webp: false,
				w: metadata.maxPageWidth,
			});

			const pressPage = await getJSON('presspage', params, docID);
			const [_, pageWidth, pageHeight, boxes] = pressPage;

			const imgReq = await fetchWithRetry(`https://drive.google.com/viewerng/img?${params.toString()}`);
			const imgBytes = await imgReq.arrayBuffer();
			const img = await pdf.embedPng(imgBytes);

			const ratio = pageWidth / pageHeight;
			const imgWidth = maxSideLength * Math.min(1, ratio);
			const imgHeight = maxSideLength / Math.max(1, ratio);
			const scale = imgWidth / pageWidth;

			const page = pdf.addPage([imgWidth, imgHeight]);
			page.drawImage(img, {
				x: 0,
				y: 0,
				width: imgWidth,
				height: imgHeight,
			});

			if (boxes) {
				const wordLeaves = collectWordLeaves(boxes).sort((left, right) => {
					const [leftY, leftX] = left[0];
					const [rightY, rightX] = right[0];
					return leftY - rightY || leftX - rightX;
				});

				for (const [box, text] of wordLeaves) {
					const [y, x, h, w] = box.map(value => value * scale);

					let size = h / font.heightAtSize(h);
					try {
						const textWidth = font.widthOfTextAtSize(text, size);
						size *= w / textWidth;

						page.drawText(text, {
							x, y: imgHeight - y - size, size, font,
							color: PDFLib.rgb(1, 1, 1),
							opacity: 0,
						});
					} catch (e) {
						console.warn(`Skipping text that can't be encoded: "${text}"`, e);
						continue;
					}
				}
			}
		}

		setStatus('Converting to PDF...', metadata.pages);
		await sleep(10);

		const fname = await getFname(tabs[0]);
		const pdfBytes = await pdf.save();
		const pdfBlob = new Blob([pdfBytes], { type: 'application/pdf' });
		const pdfURL = URL.createObjectURL(pdfBlob);
		await browser.downloads.download({ url: pdfURL, filename: fname.endsWith('.pdf') ? fname : `${fname}.pdf` });
		URL.revokeObjectURL(pdfURL);
	}
	catch (error) {
		document.body.className = 'error';
		errorContainer.innerText = 'An error occurred while downloading the document.';
		console.error(error);
	}
});
