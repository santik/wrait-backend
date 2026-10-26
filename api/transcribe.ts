import { createOperationHandler } from '../src/contracts/http.js';
import { handleTranscribe } from '../src/contracts/transcribe.js';

export const config = { api: { bodyParser: false } };

export default createOperationHandler('transcribe', handleTranscribe);
