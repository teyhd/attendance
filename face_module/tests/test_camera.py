from face_module.camera import camera_score, CameraSelection, parse_camera_spec


def test_parse_camera_spec_accepts_name_and_index():
    assert parse_camera_spec("HD Webcam") == "HD Webcam"
    assert parse_camera_spec("1") == 1
    assert parse_camera_spec("laptop") == "laptop"


def test_camera_score_rejects_black_virtual_before_visible_camera():
    black = CameraSelection(None, 0, 0, "DSHOW", "Camera 0", 1280, 720, 0.0)
    visible = CameraSelection(None, 1, 0, "DSHOW", "Camera 1", 640, 480, 130.0)
    virtual = CameraSelection(None, 2, 0, "DSHOW", "OBS Virtual Camera", 640, 480, 80.0)

    assert camera_score(visible) > camera_score(black)
    assert camera_score(visible) > camera_score(virtual)
