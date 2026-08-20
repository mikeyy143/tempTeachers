import base64
import json
import os
import requests
from PIL import Image
from io import BytesIO


BASE_URL = "https://api.apdsc.apcfss.in"

CAPTCHA_URL = f"{BASE_URL}/apdscapi/dsc-public/generate-captcha"
AUTH_URL = f"{BASE_URL}/apdscapi/auth/candidate-authenticate"
ANSWER_SHEET_URL = f"{BASE_URL}/apdscreadapi/tet-ans-sheet"


def generate_captcha(session):
    print("[1] Generating CAPTCHA...")

    response = session.post(
        CAPTCHA_URL,
        headers={
            "Accept": "application/json",
            "Content-Type": "application/json",
            "Origin": "https://tet2dsc.apcfss.in",
            "Referer": "https://tet2dsc.apcfss.in/",
        },
        timeout=30
    )

    response.raise_for_status()

    data = response.json()

    if not data.get("status"):
        raise Exception(f"CAPTCHA generation failed: {data}")

    captcha_id = data["captchaId"]
    captcha_data = data["captcha"]

    print("CAPTCHA ID:", captcha_id)

    # The API sometimes returns:
    #
    # data\:image/png;base64,...
    #
    # instead of:
    #
    # data:image/png;base64,...
    #
    captcha_data = captcha_data.replace(r"data\:", "data:")

    if "," not in captcha_data:
        raise Exception("Invalid CAPTCHA image data")

    _, encoded_image = captcha_data.split(",", 1)

    image_bytes = base64.b64decode(encoded_image)

    # Save CAPTCHA
    captcha_file = "captcha.png"

    with open(captcha_file, "wb") as f:
        f.write(image_bytes)

    print("CAPTCHA saved as:", captcha_file)

    # Display CAPTCHA
    image = Image.open(BytesIO(image_bytes))
    image.show()

    return captcha_id


def authenticate(session, username, password, captcha, captcha_id):
    print("\n[2] Authenticating...")

    payload = {
        "username": username,
        "password": password,
        "captcha": captcha,
        "captchaId": captcha_id
    }

    response = session.post(
        AUTH_URL,
        json=payload,
        headers={
            "Accept": "application/json",
            "Content-Type": "application/json",
            "Origin": "https://tet2dsc.apcfss.in",
            "Referer": "https://tet2dsc.apcfss.in/",
        },
        timeout=30
    )

    print("Authentication status:", response.status_code)

    response.raise_for_status()

    data = response.json()

    print("\nAuthentication response:")
    print(json.dumps(data, indent=4))

    if not data.get("status", False):
        raise Exception(
            "Authentication failed: "
            + data.get("message", data.get("sdesc", "Unknown error"))
        )

    return data


def extract_token(auth_data):
    """
    Try common token field names.
    """

    possible_fields = [
        "token",
        "access_token",
        "accessToken",
        "jwt",
        "id_token",
        "authorization"
    ]

    for field in possible_fields:
        value = auth_data.get(field)

        if value:
            return value

    # Sometimes token can be inside a nested data object
    nested = auth_data.get("data")

    if isinstance(nested, dict):
        for field in possible_fields:
            value = nested.get(field)

            if value:
                return value

    raise Exception(
        "Could not find Bearer token in authentication response."
    )


def get_answer_sheet(session, token):
    print("\n[3] Fetching answer-sheet information...")

    # If API already returned "Bearer xxx", don't add Bearer twice.
    if token.lower().startswith("bearer "):
        authorization = token
    else:
        authorization = f"Bearer {token}"

    response = session.get(
        ANSWER_SHEET_URL,
        headers={
            "Accept": "application/json",
            "Authorization": authorization,
            "Origin": "https://tet2dsc.apcfss.in",
            "Referer": "https://tet2dsc.apcfss.in/",
        },
        timeout=30
    )

    print("Answer sheet status:", response.status_code)

    response.raise_for_status()

    data = response.json()

    print("\nAnswer sheet response:")
    print(json.dumps(data, indent=4))

    return data


def main():

    username = input("Username: ").strip()
    password = input("Password: ").strip()

    # Session is VERY important.
    #
    # It automatically stores:
    # AWSALB
    # AWSALBCORS
    # etc.
    #
    # from generate-captcha and sends them to
    # candidate-authenticate.
    session = requests.Session()

    try:

        # -----------------------------------------
        # 1. Generate CAPTCHA
        # -----------------------------------------

        captcha_id = generate_captcha(session)

        print("\nCAPTCHA ID stored:")
        print(captcha_id)

        # -----------------------------------------
        # 2. User enters CAPTCHA
        # -----------------------------------------

        captcha = input("\nEnter CAPTCHA: ").strip()

        # -----------------------------------------
        # 3. Authenticate
        # -----------------------------------------

        auth_data = authenticate(
            session,
            username,
            password,
            captcha,
            captcha_id
        )

        # -----------------------------------------
        # 4. Extract token
        # -----------------------------------------

        token = extract_token(auth_data)

        print("\nBearer token obtained.")

        # -----------------------------------------
        # 5. Get answer sheet
        # -----------------------------------------

        answer_data = get_answer_sheet(
            session,
            token
        )

        # -----------------------------------------
        # 6. Extract qp_html_path
        # -----------------------------------------

        records = answer_data.get("data", [])

        if not records:
            print("\nNo answer-sheet records found.")
            return

        print("\n" + "=" * 80)
        print("QP HTML PATH")
        print("=" * 80)

        for i, record in enumerate(records, start=1):

            qp_html_path = record.get("qp_html_path")

            print(f"\nRecord {i}")
            print("Candidate :", record.get("candidate_name"))
            print("Exam      :", record.get("exam_id"))
            print("Subject   :", record.get("subject_name"))
            print("QP URL    :", qp_html_path)

        print("\nDone.")

    except requests.exceptions.RequestException as e:

        print("\nHTTP error:")
        print(e)

    except Exception as e:

        print("\nError:")
        print(e)


if __name__ == "__main__":
    main()