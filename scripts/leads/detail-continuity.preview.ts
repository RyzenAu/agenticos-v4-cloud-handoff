// Client-only review of the actual routes. No production backend, state or providers loaded.
import { createServer } from "vite";
import tailwind from "@tailwindcss/vite";
import { resolve } from "node:path";
const now = new Date().toISOString();
const actionsReview = process.argv.includes("--actions");
const state = { version:1, goals:{longTerm:"",quarter:"",week:"",metrics:[]}, hiddenMemoryTitles:[], sources:[], inbox:[], events:[], settings:{mission:false,openclaw:false,news:false} };
const fixtures: Record<string, unknown> = {
  "/__operator/state": state,
  "/__token": {token:"synthetic-page-token"},
  "/__devices/me": {authorised:true, principal:{personId:"synthetic-owner",displayName:"Review workspace",via:"local"}},
  "/__operator/profile": {name:"Review workspace",role:"",about:"",responsePreferences:"",timeZone:"Australia/Sydney",currency:"AUD",avatar:"",publicProfiles:[],tools:[],city:"",onboardingFlowVersion:2,onboardingStep:4,onboardingCompletedAt:now},
  "/__operator/business": {profile:{businessName:"Synthetic business"},snapshots:[],widgets:{cash:false,goals:false,dailyBrief:false,aiSpend:false,dream:false,inbox:false,calendar:false,memory:false,audience:false},progress:{goals:[],updates:[]}},
  "/__operator/business/demo": {enabled:false,liveData:false},
  "/__operator/coding/jobs": {jobs:[],liveJobs:[]},
  "/__operator/coding/accounts": {accounts:[],codexIsolation:{state:"paused",label:"Not checked",detail:"Synthetic fixture",approvedAt:null,protectedPaths:null}},
  "/__operator/coding/repos": {repos:[{id:"synthetic-repo",description:"Fabricated review repository",defaultBaseRef:"main"}]},
  "/__operator/coding/focus": {focus:null},
  "/__design_ledger": {ok:true,items:[],armed:false},
  "/__design_jobs": {ok:true,jobs:[]},
  "/__operator/models": {models:[],statuses:[],checkedAt:null,checking:false},
  "/__operator/capabilities": {generatedAt:null,capabilities:[],note:"No tool check in this fixture"},
  "/__app_version": {version:"review",date:now,hash:"synthetic"},
  "/__version": {version:"review",gitSha:"synthetic",buildTime:now},
  "/__dev_restart": {pending:false,quietMs:5000,maxDeferMs:60000},
  "/__jobs": {jobs:[]},
  "/__operator/jobs": {jobs:[]},
};
const server = await createServer({
  configFile:false, envFile:false, root:process.cwd(), logLevel:"error",
  server:{host:"127.0.0.1",port:actionsReview ? 4400 : 4398,strictPort:true,hmr:false,watch:{ignored:["**/outputs/**"]}},
  resolve:{alias:{"@":resolve("src")}},
  esbuild:{jsx:"automatic"},
  plugins:[tailwind(),{name:"synthetic-only-routes",configureServer(s){
    s.middlewares.use(async (req,res,next)=>{
      const path=new URL(req.url ?? "/","http://localhost").pathname;
      if(path.startsWith("/__")) {
        res.setHeader("Content-Type","application/json");
        const fixture=fixtures[path];
        res.statusCode=fixture ? 200 : 503;
        res.end(JSON.stringify(fixture ?? {ok:false,error:"Not configured in this synthetic review",note:"Not configured in this synthetic review"}));
        return;
      }
      if(path==="/" || (!path.includes(".") && !path.startsWith("/@"))) {
        res.setHeader("Content-Type","text/html");
        const entry = actionsReview ? "/scripts/workspace/actions.fixture.tsx" : "/scripts/leads/detail-continuity.fixture.tsx";
        res.end(await s.transformIndexHtml(path,`<!doctype html><html class="dark"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/src/styles.css"><link rel="stylesheet" href="/src/operator.css"></head><body><div id="root"></div><script type="module" src="${entry}"></script></body></html>`));
        return;
      }
      next();
    });
  }}],
});
await server.listen();
console.log(`Synthetic UI review ready at http://127.0.0.1:${actionsReview ? 4400 : 4398}; no live backend loaded.`);
