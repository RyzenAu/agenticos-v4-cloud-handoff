import { createRoot } from "react-dom/client";
import { NabConnection } from "../../src/components/finance/nab-connection";
import "../../src/styles.css";

createRoot(document.getElementById("root")!).render(<div className="mx-auto max-w-5xl p-4 sm:p-8"><NabConnection /></div>);
