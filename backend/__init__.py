"""Accuracy-first admission prediction backend."""

from .data_pipeline import AdmissionRow, build_official_dataset

__all__ = ["AdmissionRow", "build_official_dataset"]
