const browser = chrome;
const maxSideLength = 600;

const errorContainer = document.querySelector('#error-container');

const downloadButton = document.querySelector('button');
const downloadFname = document.querySelector('#fname');

const progressContainer = document.querySelector('#progress-container');
const progressBar = document.querySelector('progress');
const progressCurrent = document.querySelector('#current-page');
const progressTotal = document.querySelector('#total-pages');

const successContainer = document.querySelector('#success-container');

async function sleep(ms) {
	return new Promise(resolve => setTimeout(resolve, ms));
}

async function getFname(tab) {
	return (await browser.scripting.executeScript({
		target: { tabId: tab.id },
		func: tab.url.includes('docs.google.com') ?
			(() => document.querySelector('#docs-title-input-label-inner').innerText) :
			(() => document.querySelector('[aria-label$=" icon"]').nextSibling.innerText),
	}))[0].result;
}

async function refreshViewID(docID) {
	const oldID = (await browser.storage.session.get(docID))[docID];
	const backgroundTab = await browser.tabs.create({
		active: false,
		url: `https://drive.google.com/file/d/${docID}/edit`,
	});
	for (let i = 0; i < 40; i++) {
		viewID = (await browser.storage.session.get(docID))[docID];
		if (viewID != oldID) break;
		await sleep(250);
	}
	if (!viewID) {
		throw new Error('Failed to refresh viewID for this document.');
	}
	browser.tabs.remove(backgroundTab.id);
	return viewID;
}

async function getJSON(endpoint, params, docID) {
	let req = await fetch(`https://drive.google.com/viewerng/${endpoint}?${params.toString()}`);
	if (!req.ok) {
		params.set('id', await refreshViewID(docID));
		req = await fetch(`https://drive.google.com/viewerng/${endpoint}?${params.toString()}`);
	}

	const text = await req.text();
	const json = text.split('\n').at(-1);
	return JSON.parse(json);
}

document.addEventListener('DOMContentLoaded', async () => {
	const tabs = await browser.tabs.query({ active: true, currentWindow: true });
	if (tabs[0].url.includes('drive.google.com') || tabs[0].url.includes('docs.google.com')) {
		downloadFname.innerText = await getFname(tabs[0]);
	}
	else {
		downloadButton.disabled = true;
		errorContainer.style.display = 'block';
	}
});

downloadButton.addEventListener('click', async () => {
	downloadButton.style.display = 'none';
	progressContainer.style.display = 'block';

	const tabs = await browser.tabs.query({ active: true, currentWindow: true });
	const url = new URL(tabs[0].url);
	const docID = url.pathname.split('/')[3];
	const authuser = url.searchParams.get('authuser') || '0';

	let viewID = (await browser.storage.session.get(docID))[docID];
	if (!viewID) await refreshViewID(docID);

	const pdf = await PDFLib.PDFDocument.create();
	const font = await pdf.embedFont(PDFLib.StandardFonts.Helvetica);

	const metadata = await getJSON('meta', new URLSearchParams({
		id: viewID,
		authuser,
	}), docID);
	progressBar.max = metadata.pages;
	progressTotal.innerText = metadata.pages;

	for (let i = 0; i < metadata.pages; i++) {
		progressBar.value = i;
		progressCurrent.innerText = i + 1;

		const params = new URLSearchParams({
			id: viewID,
			authuser,
			page: i,
			webp: false,
			w: metadata.maxPageWidth,
		});

		const pressPage = await getJSON('presspage', params, docID);
		const [_, pageWidth, pageHeight, boxes] = pressPage;


		const imgReq = await fetch(`https://drive.google.com/viewerng/img?${params.toString()}`);
		const imgBytes = await imgReq.arrayBuffer();
		const img = await pdf.embedPng(imgBytes);

		const ratio = pageWidth / pageHeight;
		const imgWidth = maxSideLength * Math.min(1, ratio);
		const imgHeight = maxSideLength / Math.max(1, ratio);
		const scale = imgWidth / pageWidth;

		const page = pdf.addPage([imgWidth, imgHeight])
		page.drawImage(img, {
			x: 0,
			y: 0,
			width: imgWidth,
			height: imgHeight,
		});

		if (boxes) {
			for (const box of boxes) {
				const text = box[1][0][1][0][1];
				const [y, x, h, w] = box[1][0][1][0][0].map(v => v * scale);

				let size = h / font.heightAtSize(h);
				const textWidth = font.widthOfTextAtSize(text, size);
				size *= w / textWidth;

				page.drawText(text, {
					x, y: imgHeight - y - size, size, font,
					color: PDFLib.rgb(1, 1, 1),
					opacity: 0,
				});
			}
		}
		}

	const fname = await getFname(tabs[0]);
	const pdfBytes = await pdf.save();
	const pdfBlob = new Blob([pdfBytes], { type: 'application/pdf' });
	const pdfURL = URL.createObjectURL(pdfBlob);
	await browser.downloads.download({ url: pdfURL, filename: fname.endsWith('.pdf') ? fname : `${fname}.pdf` });
	URL.revokeObjectURL(pdfURL);

	progressContainer.style.display = 'none';
	successContainer.style.display = 'block';
});