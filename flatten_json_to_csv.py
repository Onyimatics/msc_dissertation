import json
import pandas as pd
import os


def flatten_forum_json(json_path, output_csv_path=None):
    """
    Flatten nested JSON data from forum scraping into a CSV format

    Parameters:
    json_path (str): Path to the JSON file
    output_csv_path (str, optional): Path for output CSV file

    Returns:
    pandas.DataFrame: The flattened data
    """
    # Check if file exists
    if not os.path.exists(json_path):
        print(f"Error: File {json_path} not found")
        return None

    try:
        # Load JSON data
        with open(json_path, "r", encoding="utf-8") as f:
            data = json.load(f)

        flattened = []

        for thread in data:
            # Extract thread metadata
            thread_meta = {
                "thread_id": thread["thread_id"],
                "thread_title": thread["thread_title"],
                "thread_url": thread["thread_url"],
                "forum_category": thread["forum_category"],
                "thread_views": thread.get("thread_views"),
                "thread_replies": thread.get("thread_replies")
            }

            # Process original post
            op = thread["original_post"]
            if op:  # Check if original post exists
                flattened.append({
                    **thread_meta,
                    "post_type": "original_post",
                    **op
                })

            # Process replies
            for reply in thread.get("replies", []):
                flattened.append({
                    **thread_meta,
                    "post_type": "reply",
                    **reply
                })

        # Convert to DataFrame
        df = pd.DataFrame(flattened)

        # Save to CSV if output path is provided
        if not output_csv_path:
            output_csv_path = json_path.replace(".json", "_flattened.csv")

        df.to_csv(output_csv_path, index=False)
        print(f"✅ Flattened CSV saved to {output_csv_path}")

        return df

    except Exception as e:
        print(f"Error processing JSON file: {e}")
        return None


# Example usage
if __name__ == "__main__":
    flatten_forum_json("fibro_forum_data_full.json")
