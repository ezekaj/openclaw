diff --git a/src/infra/tool-analytics-rl.ts b/src/infra/tool-analytics-rl.ts
index 1234567..abcdefg 100644
--- a/src/infra/tool-analytics-rl.ts
+++ b/src/infra/tool-analytics-rl.ts
@@ -15,7 +15,6 @@ import { createSubsystemLogger } from "../logging/subsystem.js";
 
 const log = createSubsystemLogger("analytics:rl");
 
-interface Experience {
+interface Experience {
   contextVector: number[];
   action: string;
   reward: number;
@@ -25,10 +24,6 @@ interface Experience {
   done: boolean;
 }
 
-interface NetworkConfig {
-  hiddenLayers: number[];
-  learningRate: number;
-  explorationRate: number;
-  discountFactor: number;
-}
-
 interface RLConfig {
   enabled: boolean;
   learningRate: number;