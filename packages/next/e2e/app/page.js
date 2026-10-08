import { app } from "../server/app.js";
import { direct } from "../../index.js";

export const dynamic = "force-dynamic";

// a Server Component, asking the API in the same process
export default async function Page() {
  const tea = await direct(app).get("/app-api/teas/:id", { params: { id: 3 } });
  return <p id="tea">{tea.ok ? `tea ${tea.data.id}: ${tea.data.name}` : "no tea"}</p>;
}
