import { createRoot } from "react-dom/client";
import { FinanceDestination } from "../../src/components/finance/manual-finance";
import "../../src/styles.css";

createRoot(document.getElementById("root")!).render(<div className="mx-auto max-w-[1400px] px-4 py-6 sm:px-8 sm:py-10"><FinanceDestination /></div>);
