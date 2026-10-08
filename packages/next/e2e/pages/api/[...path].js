import { app } from "../../server/app.js";
import { pages } from "../../../index.js";

export const config = { api: { bodyParser: false, externalResolver: true } };
export default pages(app);
