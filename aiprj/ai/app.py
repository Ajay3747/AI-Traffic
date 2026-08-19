import os
import base64
import logging
import math
import requests

import numpy as np
import cv2

from flask import Flask, request, jsonify
from flask_cors import CORS

from detect import (
    analyze_video,
    calculate_green_duration,
    analyze_cv2_frame,
    AIProcessingError
)


# ============================================================
# LOGGING
# ============================================================

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s"
)

logger = logging.getLogger("ai.app")


# ============================================================
# FLASK APP
# ============================================================

app = Flask(__name__)

CORS(app)


# ============================================================
# EMERGENCY VEHICLE CONFIGURATION
# ============================================================

# Fixed coordinates of your demo traffic junction.
#
# IMPORTANT:
# These coordinates represent the LOGICAL location of the
# traffic junction.
#
# They do NOT need to be the physical location of your ESP32
# during the prototype.
#
JUNCTIONS = {

    "Junction_A": {
        "lat": 11.2765,
        "lon": 77.5840
    },

    # You can add more junctions later:
    #
    # "Junction_B": {
    #     "lat": 11.2800,
    #     "lon": 77.5900
    # },
    #
    # "Junction_C": {
    #     "lat": 11.2850,
    #     "lon": 77.5950
    # }

}


# ============================================================
# ESP32 CONFIGURATION
# ============================================================

# CHANGE THIS TO YOUR ESP32 IP ADDRESS.
#
# Example:
#
# ESP32_URL = "http://10.93.224.100/emergency"
#
ESP32_URL = "http://10.93.224.100/emergency"


# Emergency activation radius in meters.
#
# Example:
#
# 500 = ambulance within 500 meters of junction
#
EMERGENCY_RADIUS = 500


# ============================================================
# GPS DISTANCE CALCULATION
# ============================================================

def calculate_distance(lat1, lon1, lat2, lon2):
    """
    Calculate distance between two GPS coordinates.

    Returns:
        Distance in meters
    """

    R = 6371000  # Earth radius in meters

    lat1_rad = math.radians(lat1)
    lat2_rad = math.radians(lat2)

    dlat = math.radians(lat2 - lat1)
    dlon = math.radians(lon2 - lon1)

    a = (
        math.sin(dlat / 2) ** 2
        +
        math.cos(lat1_rad)
        * math.cos(lat2_rad)
        * math.sin(dlon / 2) ** 2
    )

    c = 2 * math.atan2(
        math.sqrt(a),
        math.sqrt(1 - a)
    )

    return R * c


# ============================================================
# HEALTH CHECK
# ============================================================

@app.route('/health', methods=['GET'])
def health():

    return jsonify({
        "status": "ok",
        "service": "flask-ai-module"
    })


# ============================================================
# HOME ROUTE
# ============================================================

@app.route('/', methods=['GET'])
def home():

    return jsonify({
        "status": "online",
        "service": "Smart Traffic AI Server",
        "message": "Flask AI backend is running",
        "endpoints": [
            "/health",
            "/analyze",
            "/analyze-frame",
            "/emergency/location"
        ]
    })


# ============================================================
# EMERGENCY VEHICLE GPS
# ============================================================

@app.route('/emergency/location', methods=['POST'])
def emergency_location():

    data = request.get_json(silent=True)

    # --------------------------------------------------------
    # Validate request
    # --------------------------------------------------------

    if not data:

        return jsonify({
            "error": "No GPS data received"
        }), 400


    try:

        ambulance_id = data.get(
            "ambulanceId",
            "AMB-001"
        )

        latitude = float(
            data["latitude"]
        )

        longitude = float(
            data["longitude"]
        )

        speed = float(
            data.get("speed", 0)
        )

        heading = float(
            data.get("heading", 0)
        )

        emergency = bool(
            data.get("emergency", False)
        )

    except (KeyError, ValueError, TypeError) as e:

        logger.error(
            f"Invalid GPS data: {e}"
        )

        return jsonify({
            "error": f"Invalid GPS data: {e}"
        }), 400


    # --------------------------------------------------------
    # Log GPS information
    # --------------------------------------------------------

    logger.info(
        f"🚑 AMBULANCE GPS | "
        f"ID={ambulance_id} | "
        f"Lat={latitude:.6f} | "
        f"Lon={longitude:.6f} | "
        f"Speed={speed:.1f} km/h | "
        f"Heading={heading:.1f}° | "
        f"Emergency={emergency}"
    )


    # --------------------------------------------------------
    # Emergency OFF
    # --------------------------------------------------------

    if not emergency:

        logger.info(
            f"ℹ️ Emergency inactive for {ambulance_id}"
        )

        return jsonify({
            "status": "normal",
            "ambulanceId": ambulance_id,
            "latitude": latitude,
            "longitude": longitude,
            "message": "Emergency mode inactive"
        })


    # ========================================================
    # FIND NEAREST JUNCTION
    # ========================================================

    nearest_junction = None

    nearest_distance = float("inf")


    for name, junction in JUNCTIONS.items():

        distance = calculate_distance(
            latitude,
            longitude,
            junction["lat"],
            junction["lon"]
        )


        logger.info(
            f"📍 Distance to {name}: "
            f"{distance:.2f} meters"
        )


        if distance < nearest_distance:

            nearest_distance = distance

            nearest_junction = name


    # --------------------------------------------------------
    # No junction configured
    # --------------------------------------------------------

    if nearest_junction is None:

        logger.error(
            "No junctions configured"
        )

        return jsonify({
            "error": "No traffic junction configured"
        }), 500


    logger.info(
        f"📍 Nearest junction = "
        f"{nearest_junction} "
        f"({nearest_distance:.2f} m)"
    )


    # ========================================================
    # CHECK EMERGENCY RADIUS
    # ========================================================

    if nearest_distance <= EMERGENCY_RADIUS:

        logger.warning(
            f"🚨 EMERGENCY APPROACHING | "
            f"{ambulance_id} → "
            f"{nearest_junction}"
        )


        # ====================================================
        # CREATE ESP32 COMMAND
        # ====================================================

        command = {

            "command": "EMERGENCY",

            "ambulanceId": ambulance_id,

            "junction": nearest_junction,

            "latitude": latitude,

            "longitude": longitude,

            "speed": speed,

            "heading": heading,

            "distance": round(
                nearest_distance,
                2
            )

        }


        logger.info(
            f"📡 Sending command to ESP32: "
            f"{command}"
        )


        # ====================================================
        # SEND COMMAND TO ESP32
        # ====================================================

        try:

            response = requests.post(

                ESP32_URL,

                json=command,

                timeout=2

            )


            logger.info(
                f"📡 ESP32 response: "
                f"{response.status_code}"
            )


            esp32_status = "command_sent"


            # Try to read ESP32 response

            try:

                esp32_response = response.json()

            except Exception:

                esp32_response = {
                    "raw": response.text
                }


        except requests.RequestException as e:

            logger.error(
                f"❌ ESP32 communication failed: "
                f"{e}"
            )


            esp32_status = "esp32_offline"

            esp32_response = {
                "error": str(e)
            }


        # ====================================================
        # RETURN EMERGENCY RESULT
        # ====================================================

        return jsonify({

            "status": "emergency",

            "ambulanceId": ambulance_id,

            "junction": nearest_junction,

            "latitude": latitude,

            "longitude": longitude,

            "distance": round(
                nearest_distance,
                2
            ),

            "heading": heading,

            "speed": speed,

            "emergency": True,

            "esp32": esp32_status,

            "esp32_response": esp32_response

        })


    # ========================================================
    # AMBULANCE OUTSIDE EMERGENCY RADIUS
    # ========================================================

    logger.info(
        f"🚑 Ambulance tracking | "
        f"{nearest_distance:.2f}m from "
        f"{nearest_junction}"
    )


    return jsonify({

        "status": "tracking",

        "ambulanceId": ambulance_id,

        "latitude": latitude,

        "longitude": longitude,

        "junction": nearest_junction,

        "distance": round(
            nearest_distance,
            2
        ),

        "heading": heading,

        "speed": speed,

        "emergency": True,

        "message": (
            "Ambulance is being tracked. "
            "Outside emergency radius."
        )

    })


# ============================================================
# NORMAL TRAFFIC VIDEO ANALYSIS
# ============================================================

@app.route('/analyze', methods=['POST'])
def analyze():

    data = request.get_json(silent=True)


    if (
        not data
        or 'videos' not in data
        or not isinstance(
            data.get('videos'),
            dict
        )
    ):

        return jsonify({

            "error": (
                "Invalid or missing 'videos'. "
                "Expected JSON: "
                "{ 'videos': "
                "{ 'North': 'path', ... } }"
            )

        }), 400


    videos = data['videos']


    logger.info(
        f"Received analyze request for "
        f"{len(videos)} roads: "
        f"{list(videos.keys())}"
    )


    results = {}


    for road, video_path in videos.items():

        # ----------------------------------------------------
        # Empty video
        # ----------------------------------------------------

        if not video_path:

            results[road] = {

                "count": 0,

                "seconds": 15,

                "emergency": False

            }

            continue


        # ----------------------------------------------------
        # Analyze video using YOLO
        # ----------------------------------------------------

        try:

            analysis_res = analyze_video(
                video_path,
                road_name=road
            )


            count = analysis_res["count"]

            emergency = analysis_res.get(
                "emergency",
                False
            )


            seconds = calculate_green_duration(
                count
            )


            results[road] = {

                "count": count,

                "seconds": seconds,

                "emergency": emergency

            }


        except AIProcessingError as e:

            logger.error(
                f"AI processing failed for "
                f"road '{road}': {e}"
            )


            results[road] = {

                "count": 0,

                "seconds": calculate_green_duration(0),

                "emergency": False,

                "failed": True,

                "error": str(e)

            }


        except Exception as e:

            logger.error(
                f"Unexpected error processing "
                f"video for {road}: {e}"
            )


            results[road] = {

                "count": 0,

                "seconds": calculate_green_duration(0),

                "emergency": False,

                "failed": True,

                "error": str(e)

            }


    logger.info(
        f"Analysis complete. "
        f"Results: {results}"
    )


    return jsonify(results)


# ============================================================
# SINGLE FRAME ANALYSIS
# ============================================================

@app.route('/analyze-frame', methods=['POST'])
def analyze_frame_route():

    data = request.get_json(
        silent=True
    )


    if (
        not data
        or 'image' not in data
        or not data.get('image')
    ):

        return jsonify({
            "error": "No image provided"
        }), 400


    try:

        img_data = data['image']


        # ----------------------------------------------------
        # Remove data URL prefix
        # ----------------------------------------------------

        if ',' in img_data:

            img_data = img_data.split(
                ',',
                1
            )[1]


        # ----------------------------------------------------
        # Decode Base64
        # ----------------------------------------------------

        try:

            img_bytes = base64.b64decode(
                img_data,
                validate=True
            )

        except Exception as decode_err:

            return jsonify({

                "error":
                    "Invalid base64 image data: "
                    f"{decode_err}"

            }), 400


        # ----------------------------------------------------
        # Convert bytes to NumPy
        # ----------------------------------------------------

        np_arr = np.frombuffer(
            img_bytes,
            np.uint8
        )


        frame = (
            cv2.imdecode(
                np_arr,
                cv2.IMREAD_COLOR
            )
            if np_arr.size > 0
            else None
        )


        if frame is None:

            return jsonify({

                "error":
                    "Could not decode image data "
                    "into a valid frame"

            }), 400


        # ----------------------------------------------------
        # Road name
        # ----------------------------------------------------

        road = data.get(
            'road',
            'Webcam'
        )


        # ----------------------------------------------------
        # YOLO frame analysis
        # ----------------------------------------------------

        try:

            analysis_res = analyze_cv2_frame(
                frame,
                road_name=road
            )


        except AIProcessingError as e:

            logger.error(
                f"AI processing failed for "
                f"frame on road '{road}': {e}"
            )


            return jsonify({

                "count": 0,

                "seconds":
                    calculate_green_duration(0),

                "emergency": False,

                "failed": True,

                "error": str(e)

            })


        # ----------------------------------------------------
        # Results
        # ----------------------------------------------------

        count = analysis_res["count"]


        emergency = analysis_res.get(
            "emergency",
            False
        )


        seconds = calculate_green_duration(
            count
        )


        return jsonify({

            "count": count,

            "seconds": seconds,

            "emergency": emergency

        })


    except Exception as e:

        logger.error(
            f"Error analyzing uploaded frame: {e}"
        )


        return jsonify({

            "count": 0,

            "seconds":
                calculate_green_duration(0),

            "emergency": False,

            "failed": True,

            "error": str(e)

        }), 500


# ============================================================
# RUN SERVER
# ============================================================

if __name__ == '__main__':

    logger.info(
        "Starting Smart Traffic AI Server..."
    )

    logger.info(
        "Emergency GPS endpoint: "
        "/emergency/location"
    )

    logger.info(
        f"ESP32 endpoint: {ESP32_URL}"
    )

    logger.info(
        f"Emergency radius: "
        f"{EMERGENCY_RADIUS} meters"
    )


    app.run(

        host='0.0.0.0',

        port=5000,

        debug=True,

        threaded=False,

        use_reloader=False

    )