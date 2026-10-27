# Vision dependency inventory

Cocoon Studio runs hand tracking locally. No inference service or camera relay is used.

| Asset | Pinned source | License / verification |
| --- | --- | --- |
| MediaPipe Tasks Vision JavaScript and module WASM | `@mediapipe/tasks-vision@1.1.1`, exact npm integrity in `package-lock.json` | Apache-2.0; full upstream license in `apps/web/public/vision/MEDIAPIPE-LICENSE.txt` |
| Hand Landmarker float16 model, version 1 | https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task | Apache-2.0; SHA-256 `fbc2a30080c3c557093b5ddfc334698132eb341044ccee322ccf8bcf3607cde1`; unmodified |
| Right-hands test photograph | https://storage.googleapis.com/mediapipe-assets/right_hands.jpg | Upstream MediaPipe test fixture, used only by automated tests; see upstream LICENSE and `mediapipe/tasks/cc/vision/hand_landmarker/hand_landmarks_detector_graph_test.cc` |

The build copies the module loader and WASM from the installed pinned package and verifies the checked-in model hash. All runtime vision assets are served from Ripple's own static path. They load only after the viewer enables hand controls. The main page and ordinary overlay do not load the vision runtime.

Upstream code and license: https://github.com/google-ai-edge/mediapipe

Hand-tracking model card: https://storage.googleapis.com/mediapipe-assets/Model%20Card%20Hand%20Tracking%20(Lite_Full)%20with%20Fairness%20Oct%202021.pdf

Library privacy notice: https://developers.google.com/edge/mediapipe/solutions/tasks#mediapipe_tasks_privacy_notice
