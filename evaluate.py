import json
import sys
import os
from dotenv import load_dotenv

load_dotenv()


def extract_top_products(
    input_file="products.json",
    output_file="top_products_urls.txt",
    k=None,
    ratings_threshold=None,
):
    """
    Read products from JSON file and save URLs of top k products by ratingsCount.

    Args:
        input_file: Path to input JSON file
        output_file: Path to output text file
        k: Number of top products to extract
        ratings_threshold: Minimum rating threshold
    """
    try:
        # Get values from .env if not provided
        if k is None:
            k = int(os.getenv("TOP_PRODUCTS_COUNT", "50"))
        if ratings_threshold is None:
            ratings_threshold = float(os.getenv("RATINGS_THRESHOLD", "4.2"))
        
        # Read the products JSON file
        with open(input_file, "r", encoding="utf-8") as f:
            products = json.load(f)

        products = [p for p in products if p.get("ratings", 0) >= ratings_threshold]

        # Sort products by ratingsCount in descending order
        sorted_products = sorted(
            products, key=lambda x: x.get("ratingsCount", 0), reverse=True
        )

        
        # save in a json file 
        with open("sorted_top_products.json", "w", encoding="utf-8") as f:
            json.dump(sorted_products, f, indent=4)

        # Extract normalized URLs
        urls = [product["url"] for product in sorted_products]

        # Save URLs to file
        with open(output_file, "w", encoding="utf-8") as f:
            for url in urls:
                f.write(url + "\n")

        print(f"✓ Extracted {len(urls)} unique URLs from top products by ratings count")
        print(f"✓ Saved to {output_file}")


    except FileNotFoundError:
        print(f"Error: File '{input_file}' not found.")
        sys.exit(1)
    except json.JSONDecodeError:
        print(f"Error: Invalid JSON in '{input_file}'.")
        sys.exit(1)
    except Exception as e:
        print(f"Error: {e}")
        sys.exit(1)


if __name__ == "__main__":

    # Allow command line argument for k
    if len(sys.argv) > 1:
        try:
            k = int(sys.argv[1])
        except ValueError:
            print("Usage: python extract_top_products.py [k]")
            print("k must be a positive integer")
            sys.exit(1)

    extract_top_products()
