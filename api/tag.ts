import { createOperationHandler } from '../src/contracts/http.js';
import { handleTag } from '../src/contracts/tag.js';

export const config = { api: { bodyParser: false } };

export default createOperationHandler('tag', handleTag);
