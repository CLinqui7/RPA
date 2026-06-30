import { processDownloadedDocuments } from './po/poRepository.js';

const limitArg = process.argv.find(arg => arg.startsWith('--limit='));
const documentArg = process.argv.find(arg => arg.startsWith('--document-id='));

const limit = limitArg ? Number(limitArg.split('=')[1]) : 20;
const documentId = documentArg ? documentArg.split('=')[1] : null;

const result = await processDownloadedDocuments({ limit, documentId });
console.log(JSON.stringify(result, null, 2));
