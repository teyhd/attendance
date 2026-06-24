# Face Module

Local face recognition module for Attendance.

Pipeline:
- OpenCV YuNet detects one face and landmarks.
- OpenCV SFace creates an aligned face embedding.
- `train_model.py` builds a local embedding index.
- `recognize_camera.py` recognizes a stable face from the laptop camera and can write arrival/departure events.

Runtime data is intentionally not tracked by Git:
- `face_module/data/`
- `face_module/models/*.onnx`
- `face_module/*.env`
- `*.npz`

## Install

```powershell
python -m pip install -r face_module/requirements.txt
python -m pip install -r face_module/requirements-dev.txt
```

`Pillow` is required for Russian text rendering in the camera preview.

Place the OpenCV Zoo ONNX files in `face_module/models/`:
- `face_detection_yunet_2023mar.onnx`
- `face_recognition_sface_2021dec.onnx`

## Collect Dataset

```powershell
python face_module/collect_dataset.py --student-id 48 --samples 40 --camera "HD Webcam"
```

The collector saves aligned face crops and metadata under `face_module/data/dataset/<student_id>/`.

## Train Index

```powershell
python face_module/train_model.py --dataset face_module/data/dataset --out face_module/data/face_index.npz --threshold 0.70 --margin 0.10
```

The script does not train a neural network. It builds normalized SFace centroids per student.

## Recognize With Preview

Dry-run mode does not write to the database:

```powershell
python face_module/recognize_camera.py --camera "HD Webcam"
```

Production logging mode writes to `attendance.presence_events`:

```powershell
python face_module/recognize_camera.py --camera "HD Webcam" --log-attendance --station-id main-door
```

If DB settings are stored outside the repository root `.env`, pass the file explicitly:

```powershell
python face_module/recognize_camera.py --camera "HD Webcam" --log-attendance --db-env C:\path\to\attendance.env
```

Useful options:
- `--stable-seconds 1.5`
- `--min-stable-frames 8`
- `--leave-seconds 1.0`
- `--event-cooldown-seconds 20`
- `--max-session-seconds 0`
- `--db-env C:\path\to\attendance.env`
- `--no-sound`

The preview window is a fixed 960x540 kiosk view. It fits the live frame without cropping, draws the face box, and shows one compact overlay with the Russian recognition status and student name from SSO. A green shrinking ring shows confirmation progress. Arrival and departure use different visual flashes and sounds.

## Attendance Rules

`recognize_camera.py` logs an event only when:
- exactly one face is detected;
- image quality passes size, blur, brightness, and detector score checks;
- the face index returns `recognized`, not `unknown` or `ambiguous`;
- the same student remains stable for both the configured time and frame count;
- the previous event has been followed by a leave period.

The first accepted recognition toggles to arrival if the latest event for the day is empty or departure. The next accepted recognition toggles to departure, but only after the student has left the frame.

`confidence` is a technical score derived from similarity over threshold. It is not a probability that the identity is correct.

## Database

`attendance_log.py` reads:
- `MDBHOST`
- `DBUSER`
- `DBPASS`
- `DBNAMESUSR`

It reads students from `sso.users` and writes only to `attendance.presence_events` with `source = 'face'`. It uses a MySQL named lock, transaction, latest-event lookup, idempotency key, and cooldown.

`DBPASS` may be empty for a local MySQL account. `MDBHOST` and `DBUSER` are required. If `--log-attendance` cannot connect, the recognizer exits before opening the camera and prints a JSON error such as `database_environment_missing` or `database_connect_failed`.

## Production Safeguards

Do not deploy this as a fully autonomous turnstile without presentation attack detection or a physically supervised point. Facial recognition is probabilistic and biometric data is sensitive. A school deployment also needs consent or another legal basis, local biometric storage controls, access limits, and a deletion process for students who leave the system.

References:
- OpenCV FaceDetectorYN: https://docs.opencv.org/4.x/df/d20/classcv_1_1FaceDetectorYN.html
- OpenCV FaceRecognizerSF: https://docs.opencv.org/4.x/da/d09/classcv_1_1FaceRecognizerSF.html
- NIST SP 800-63B Biometrics: https://pages.nist.gov/800-63-4/sp800-63b.html#use-of-biometrics
- OWASP MFA Biometrics: https://cheatsheetseries.owasp.org/cheatsheets/Multifactor_Authentication_Cheat_Sheet.html#biometrics
