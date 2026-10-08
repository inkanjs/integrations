import { app } from "../../../server/app.js";
import { handlers } from "../../../../index.js";

export const { GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS } = handlers(app);
