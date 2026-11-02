import { createOperationHandler } from '../src/contracts/http.js';
import { handleCleanup } from '../src/contracts/cleanup.js';

export const config = { api: { bodyParser: false } };

export default createOperationHandler('cleanup', handleCleanup);
